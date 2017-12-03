/*
 * Copyright © 2017 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { Project } from "@atomist/automation-client/project/Project";
import { HandlerContext, logger } from "@atomist/automation-client";
import { TypeScriptES6FileParser } from "@atomist/automation-client/tree/ast/typescript/TypeScriptFileParser";
import { findMatches } from "@atomist/automation-client/tree/ast/astUtils";

import { evaluateExpression } from "@atomist/tree-path/path/expressionEngine";
import { isSuccessResult } from "@atomist/tree-path/path/pathExpression";
import { TreeNode } from "@atomist/tree-path/TreeNode";
import * as _ from "lodash";
import { MatchResult } from "@atomist/automation-client/tree/ast/FileHits";
import { EditResult, successfulEdit } from "@atomist/automation-client/operations/edit/projectEditor";
import stringify = require("json-stringify-safe");
import Requirement = AddParameter.Requirement;
import { LocatedTreeNode } from "@atomist/automation-client/tree/LocatedTreeNode";


export interface MySpecialEditReport extends EditResult {
    addParameterReport: AddParameter.Report
}

export function passContextToFunction(params: {
    name: string,
    filePath: string
}): (p: Project) => Promise<MySpecialEditReport> {
    return (p: Project) => {
        const originalRequirement: Requirement = {
            kind: "Add Parameter",
            functionWithAdditionalParameter: params,
            parameterType: { kind: "local", name: "HandlerContext", localPath: "src/HandlerContext" },
            parameterName: "context",
            why: "I want to use the context in here",
            dummyValue: "{} as HandlerContext",
        };

        return AddParameter.findConsequences(p, [originalRequirement])
            .then(reqs => implementInSequenceWithFlushes(p, reqs))
            .then(report => {
                logger.info("Report: " + stringify(report, null, 2));
                return {
                    ...successfulEdit(p, report.implemented.length > 0),
                    addParameterReport: report,
                }
            });
    }
}

function implementInSequenceWithFlushes(project: Project, activities: AddParameter.Requirement[]) {
    logger.info("implementing " + activities.length + " requirements: " + stringify(activities, null, 1));
    return activities.reduce(
        (pp: Promise<AddParameter.Report>, r1: Requirement) => pp
            .then(report => AddParameter.implement(project, r1)
                .then((report1) => project.flush()
                    .then(() => AddParameter.combine(report, report1)))),
        Promise.resolve(AddParameter.emptyReport));
}

export namespace AddParameter {

    export interface Unimplemented {
        requirement: Requirement,
        message: string,
    }

    export interface Report {
        unimplemented: Unimplemented[]

        implemented: Requirement[]
    }

    export const emptyReport: Report = {
        unimplemented: [],
        implemented: [],
    };

    function reportUnimplemented(requirement: Requirement, message: string): Report {
        return {
            unimplemented: [{ requirement, message }],
            implemented: [],
        }
    }

    function reportImplemented(requirement: Requirement): Report {
        return {
            unimplemented: [],
            implemented: [requirement],
        }
    }

    export function combine(report1: Report, report2: Report): Report {
        return {
            unimplemented: report1.unimplemented.concat(report2.unimplemented),
            implemented: report1.implemented.concat(report2.implemented),
        }
    }

    export type FunctionIdentifier = { name: string, filePath: string };

    export type Requirement = AddParameterRequirement | PassArgumentRequirement | PassDummyInTestsRequirement

    // maybe there is a better way but this should work
    export function distinct(requirements: Requirement[]): Requirement[] {
        let result: Requirement[] = [];

        for (const r of requirements) {
            if (!result.some(other => sameRequirement(other, r))) {
                result.push(r);
            }
        }
        return result;
    }

    function sameFunctionIdentifier(r1: FunctionIdentifier, r2: FunctionIdentifier) {
        return r1.name === r2.name &&
            r1.filePath === r2.filePath

    }


    function sameRequirement(r1: Requirement, r2: Requirement): boolean {
        return r1.kind === r2.kind &&
            sameFunctionIdentifier(r1.functionWithAdditionalParameter, r2.functionWithAdditionalParameter) &&
            r1.functionWithAdditionalParameter.filePath === r2.functionWithAdditionalParameter.filePath &&
            (!isPassArgumentRequirement(r1) ||
                sameFunctionIdentifier(r1.enclosingFunction, (r2 as PassArgumentRequirement).enclosingFunction))
    }

    export interface AddParameterRequirement {
        kind: "Add Parameter";
        functionWithAdditionalParameter: FunctionIdentifier;
        parameterType: AddImport.ImportIdentifier;
        parameterName: string;
        dummyValue: string;
        why?: any;
    }

    export interface PassDummyInTestsRequirement {
        kind: "Pass Dummy In Tests";
        functionWithAdditionalParameter: FunctionIdentifier;
        dummyValue: string;
        why?: any;
    }

    export function isAddDummyInTests(r: Requirement): r is PassDummyInTestsRequirement {
        return r.kind === "Pass Dummy In Tests";
    }

    export function isAddParameterRequirement(r: Requirement): r is AddParameterRequirement {
        return r.kind === "Add Parameter";
    }


    export function isPassArgumentRequirement(r: Requirement): r is PassArgumentRequirement {
        return r.kind === "Pass Argument";
    }


    export interface PassArgumentRequirement {
        kind: "Pass Argument"
        enclosingFunction: FunctionIdentifier,
        functionWithAdditionalParameter: FunctionIdentifier;
        argumentValue: string;
        why?: any;
    }

    export function findConsequencesOfOne(project: Project, requirement: Requirement): Promise<Requirement[]> {
        if (isAddParameterRequirement(requirement)) {
            logger.info("Finding consequences of: " + stringify(requirement, null, 1));
            return findConsequencesOfAddParameter(project, requirement).then(consequences => {
                logger.info("Found " + consequences.length + " consequences");
                return consequences.map(c => ({ ...c, why: requirement }))
            });
        } else {
            return Promise.resolve([]);
        }
    }

    export function findConsequences(project: Project, unchecked: Requirement[],
                                     checked: Requirement[] = []): Promise<Requirement[]> {
        if (unchecked.length === 0) {
            return Promise.resolve(checked);
        }
        const thisOne = unchecked.pop(); // mutation
        if (checked.some(o => sameRequirement(o, thisOne))) {
            logger.info("Already checked " + stringify(thisOne));
            return findConsequences(project, unchecked, checked);
        }
        return findConsequencesOfOne(project, thisOne).then(theseReqs => {
            checked.push(thisOne);
            return findConsequences(project, unchecked.concat(theseReqs), checked)
        });
    }

    function findConsequencesOfAddParameter(project: Project, requirement: AddParameterRequirement): Promise<Requirement[]> {
        const passDummyInTests: PassDummyInTestsRequirement = {
            kind: "Pass Dummy In Tests",
            functionWithAdditionalParameter: requirement.functionWithAdditionalParameter,
            dummyValue: requirement.dummyValue,
        };
        const innerExpression = functionCallPathExpression(requirement.functionWithAdditionalParameter.name);

        // in source, either find a parameter that fits, or receive it.
        return findMatches(project, TypeScriptES6FileParser, "src/**/*.ts",
            `//FunctionDeclaration[${innerExpression}]`)
            .then(matches => {
                return _.flatMap(matches, enclosingFunction => {
                    const enclosingFunctionName = childrenNamed(enclosingFunction, "Identifier")[0].$value;

                    const filePath = (enclosingFunction as LocatedTreeNode).sourceLocation.path;
                    const parameterExpression = `/SyntaxList/Parameter[/TypeReference[@value='${requirement.parameterType.name}']]/Identifier`;
                    const suitableParameterMatches = evaluateExpression(enclosingFunction, parameterExpression);

                    if (isSuccessResult(suitableParameterMatches) && suitableParameterMatches.length > 0) {
                        const identifier = suitableParameterMatches[0];
                        // these are locatable tree nodes, I can include a line number in the instruction! sourceLocation.lineFrom1
                        logger.info("Found a call to %s inside a function called %s, with parameter %s",
                            requirement.functionWithAdditionalParameter, enclosingFunctionName, identifier.$value);

                        const instruction: PassArgumentRequirement = {
                            kind: "Pass Argument",
                            enclosingFunction: { name: enclosingFunctionName, filePath },
                            functionWithAdditionalParameter: requirement.functionWithAdditionalParameter,
                            argumentValue: identifier.$value,
                        };
                        return [instruction];
                    } else {
                        logger.info("Found a call to %s inside a function called %s, no suitable parameter",
                            requirement.functionWithAdditionalParameter, enclosingFunctionName);

                        const passNewArgument: AddParameterRequirement = {
                            kind: "Add Parameter",
                            functionWithAdditionalParameter: { name: enclosingFunctionName, filePath },
                            parameterType: requirement.parameterType,
                            parameterName: requirement.parameterName,
                            dummyValue: requirement.dummyValue,
                        };
                        const newParameterForMe: PassArgumentRequirement = {
                            kind: "Pass Argument",
                            enclosingFunction: { name: enclosingFunctionName, filePath },
                            functionWithAdditionalParameter: requirement.functionWithAdditionalParameter,
                            argumentValue: requirement.parameterName,
                        };
                        return [passNewArgument, newParameterForMe];
                    }
                })
            }).then((srcConsequences: Requirement[]) => srcConsequences.concat([passDummyInTests]));
    }

    export function implement(project: Project, requirement: Requirement): Promise<Report> {
        logger.info("Implementing: " + stringify(requirement, null, 2));
        if (isAddParameterRequirement(requirement)) {
            return addParameter(project, requirement);
        }
        if (isAddDummyInTests(requirement)) {
            return passDummyInTests(project, requirement);
        } else {
            return passArgument(project, requirement);
        }
    }

    function functionCallPathExpression(fn: string) {
        return fn.match(/\./) ?
            `//CallExpression[/PropertyAccessExpression[@value='${fn}']]` :
            `//CallExpression[/Identifier[@value='${fn}']]`;
    }

    function passArgument(project: Project, requirement: PassArgumentRequirement): Promise<Report> {
        const innerExpression = functionCallPathExpression(requirement.functionWithAdditionalParameter.name);

        const enclosingFunctionExpression = `/Identifier[@value='${requirement.enclosingFunction.name}'`;

        const fullPathExpression = `//FunctionDeclaration[${enclosingFunctionExpression}]][${innerExpression}]`;

        return findMatches(project,
            TypeScriptES6FileParser,
            "**/" + requirement.enclosingFunction.filePath,
            fullPathExpression)
            .then(mm => applyPassArgument(mm, requirement));
    }

    function applyPassArgument(matches: MatchResult[], requirement: PassArgumentRequirement): Report {
        if (matches.length === 0) {
            return reportUnimplemented(requirement, "Function not found");
        } else {
            matches.map(enclosingFunction => {
                const newValue = enclosingFunction.$value.replace(
                    new RegExp(requirement.functionWithAdditionalParameter.name + "\\s*\\(", "g"),
                    requirement.functionWithAdditionalParameter.name + `(${requirement.argumentValue}, `);
                enclosingFunction.$value = newValue;
            });
            return reportImplemented(requirement);
        }
    }

    function pathExpressionToFunctionDeclaration(fn: FunctionIdentifier): string {

        const declarationOfInterest = `/Identifier[@value='${fn.name}'`;
        const functionDeclarationExpression = `//FunctionDeclaration[${declarationOfInterest}]]`;

        // TODO: handle ones with a namespace component.

        return functionDeclarationExpression;
    }

    function passDummyInTests(project: Project, requirement: PassDummyInTestsRequirement): Promise<Report> {
        return findMatches(project, TypeScriptES6FileParser, "test/**/*.ts",
            functionCallPathExpression(requirement.functionWithAdditionalParameter.name))
            .then(matches => {
                if (matches.length === 0) {
                    return emptyReport; // it's valid for there to be no changes
                } else {
                    matches.map(functionCall => {
                        const newValue = functionCall.$value.replace(
                            new RegExp(requirement.functionWithAdditionalParameter.name + "\\s*\\(", "g"),
                            `${requirement.functionWithAdditionalParameter.name}(${requirement.dummyValue}, `);
                        functionCall.$value = newValue;

                    });
                    return reportImplemented(requirement);
                }
            })
    }


    function addParameter(project: Project, requirement: AddParameterRequirement): Promise<Report> {
        const functionDeclarationExpression = pathExpressionToFunctionDeclaration(requirement.functionWithAdditionalParameter);
        return AddImport.addImport(project,
            requirement.functionWithAdditionalParameter.filePath,
            requirement.parameterType)
            .then(() => findMatches(project, TypeScriptES6FileParser, "**/" + requirement.functionWithAdditionalParameter.filePath,
                functionDeclarationExpression)
                .then(matches => {
                    if (matches.length === 0) {
                        logger.warn("Found 0 function declarations called " +
                            requirement.functionWithAdditionalParameter.name + " in " +
                            requirement.functionWithAdditionalParameter.filePath);
                        return reportUnimplemented(requirement, "Function declaration not found");
                    } else if (1 < matches.length) {
                        logger.warn("Doing Nothing; Found more than one function declaration called " + requirement.functionWithAdditionalParameter);
                        return reportUnimplemented(requirement, "More than one function declaration matched. I'm confused.")
                    } else {
                        const functionDeclaration = matches[0];
                        const identifier = requirement.functionWithAdditionalParameter.name;

                        const newValue = functionDeclaration.$value.replace(
                            new RegExp(identifier + "\\s*\\(", "g"),
                            `${identifier}(${requirement.parameterName}: ${requirement.parameterType.name}, `);
                        functionDeclaration.$value = newValue;
                        return reportImplemented(requirement);
                    }
                }));
    }


    function childrenNamed(parent: TreeNode, name: string) {
        return parent.$children.filter(child => child.$name === name);
    }
}
export namespace AddImport {

    export type ImportIdentifier = LibraryImport | LocalImport

    export interface LibraryImport {
        kind: "library",
        name: string,
        location: string
    }

    function isLibraryImport(i: ImportIdentifier): i is LibraryImport {
        return i.kind === "library"
    }

    export interface LocalImport {
        kind: "local",
        name: string,
        localPath: string
    }

    function calculateRelativePath(from: string, to: string) {
        return to;
    }

    export function addImport(project: Project, path: string, what: ImportIdentifier): Promise<boolean> {
        return findMatches(project, TypeScriptES6FileParser, path, "/SourceFile").then(sources => {
            const source = sources[0];
            const existingImport = source.evaluateExpression(
                `//ImportDeclaration//Identifier[@value='${what.name}']`);
            if (existingImport && 0 < existingImport.length) {
                logger.debug("Import already exists: " + existingImport[0].$value);
                // import found. Not handled: the same identifier is imported from elsewhere.
                return false;
            }

            const location = isLibraryImport(what) ? what.location : calculateRelativePath(path, what.localPath);

            const locationImportMatches = source.evaluateExpression(
                `//ImportDeclaration[//StringLiteral[@value='${location}']]`);
            if (locationImportMatches && 0 < locationImportMatches.length) {
                const locationImport = locationImportMatches[0];
                // not handling: *
                const newValue = locationImport.$value.replace(
                    /{/,
                    `{ ${what.name},`);
                locationImport.$value = newValue;
                logger.debug("Adding to import. New value: " + newValue);
                return true;
            }
            // No existing import to modify. Add one.
            const newStatement = `import { ${what.name} } from "${location}";\n`;

            logger.debug("adding new import statement: " + newStatement);
            source.$value = newStatement + source.$value;
            return true;
        })
    }

}
