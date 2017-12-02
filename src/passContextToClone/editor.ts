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
import { BranchCommit } from "@atomist/automation-client/operations/edit/editModes";
import { logger } from "@atomist/automation-client";
import { TypeScriptES6FileParser } from "@atomist/automation-client/tree/ast/typescript/TypeScriptFileParser";
import { findMatches } from "@atomist/automation-client/tree/ast/astUtils";

import { evaluateExpression } from "@atomist/tree-path/path/expressionEngine";
import { isSuccessResult } from "@atomist/tree-path/path/pathExpression";
import { TreeNode } from "@atomist/tree-path/TreeNode";
import * as _ from "lodash";
import { MatchResult } from "@atomist/automation-client/tree/ast/FileHits";
import stringify = require("json-stringify-safe");
import Requirement = AddParameter.Requirement;

const saveUpgradeToGitHub: BranchCommit = {
    branch: "pass-context-to-clone-atomist",
    message: "in tests, pass a dummy context.",
};

export function passContextToFunction(functionWeWant: string,
                                      filePath: string): (p: Project) => Promise<AddParameter.Report> {
    return (p: Project) => {
        const originalRequirement: Requirement = {
            kind: "Add Parameter",
            functionWithAdditionalParameter: { name: functionWeWant, filePath },
            parameterType: "HandlerContext",
            parameterName: "context",
            why: "I want to use the context in here",
            dummyValue: "{} as HandlerContext",
        };

        const originalRequirementInArray: Requirement[] = [originalRequirement];
        return AddParameter.findConsequences(p, originalRequirement)
            .then((consequences: Requirement[]) => {
                return Promise.all(consequences.map(r =>
                    AddParameter.findConsequences(p, r))) // todo: this should be recursive, this is too limited
                    .then(arrayOfArrays =>
                        _.flatten(arrayOfArrays))
                    .then(moreConsequences => AddParameter.distinct(
                        originalRequirementInArray
                            .concat(consequences)
                            .concat(moreConsequences)))
                    .then(reqs => implementInSequenceWithFlushes(p, reqs));
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
    }

    export const emptyReport: Report = {
        unimplemented: [],
    };

    function reportUnimplemented(requirement: Requirement, message: string): Report {
        return {
            unimplemented: [{ requirement, message }],
        }
    }

    export function combine(report1: Report, report2: Report): Report {
        return {
            unimplemented: report1.unimplemented.concat(report2.unimplemented),
        }
    }

    export type FunctionIdentifier = { name: string, filePath: string };

    export type Requirement = AddParameterRequirement | PassArgumentRequirement

    // maybe there is a better way but this should work
    export function distinct(requirements: Requirement[]): Requirement[] {
        let result: Requirement[] = [];

        for (const r of requirements) {
            if (!result.some(other => stringify(other) === stringify(r))) {
                result.push(r);
            }
        }
        return result;
    }

    export interface AddParameterRequirement {
        kind: "Add Parameter";
        functionWithAdditionalParameter: FunctionIdentifier;
        parameterType: string;
        parameterName: string;
        dummyValue: string;
        why?: any;
    }

    function isAddParameterRequirement(r: Requirement): r is AddParameterRequirement {
        return r.kind === "Add Parameter";
    }

    export interface PassArgumentRequirement {
        kind: "Pass Argument"
        enclosingFunction: FunctionIdentifier,
        functionWithAdditionalParameter: FunctionIdentifier;
        argumentValue: string;
        why?: any;
    }

    export function findConsequences(project: Project, requirement: Requirement): Promise<Requirement[]> {
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

    function findConsequencesOfAddParameter(project: Project, requirement: AddParameterRequirement): Promise<Requirement[]> {

        const innerExpression = functionCallPathExpression(requirement.functionWithAdditionalParameter.name);

        // in source, either find a parameter that fits, or receive it.
        return findMatches(project, TypeScriptES6FileParser, "src/**/*.ts",
            `//FunctionDeclaration[${innerExpression}]`)
            .then(matches => {
                return _.flatMap(matches, enclosingFunction => {
                    const enclosingFunctionName = childrenNamed(enclosingFunction, "Identifier")[0].$value;

                    const filePath = (enclosingFunction as any).sourceFile.fileName;
                    const parameterExpression = `/SyntaxList/Parameter[/TypeReference[@value='${requirement.parameterType}']]/Identifier`;
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
                });
            })
            // in tests, pass a dummy value.
            .then(srcRequirements => findMatches(project, TypeScriptES6FileParser, "test/**/*.ts",
                `${innerExpression}`)
                .then(matches => {
                    return _.flatMap(matches, enclosingFunction => {
                        const filePath = (enclosingFunction as any).sourceFile.fileName;
                        const enclosingFunctionName = childrenNamed(enclosingFunction, "Identifier")[0].$value;
                        const instruction: PassArgumentRequirement = {
                            kind: "Pass Argument",
                            enclosingFunction: { name: enclosingFunctionName, filePath },
                            functionWithAdditionalParameter: requirement.functionWithAdditionalParameter,
                            argumentValue: requirement.dummyValue,
                        };
                        return [instruction];

                    });
                })
                .then(testRequirements => srcRequirements.concat(testRequirements)))
    }

    export function implement(project: Project, requirement: Requirement): Promise<Report> {
        if (isAddParameterRequirement(requirement)) {
            return addParameter(project, requirement);
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
            requirement.functionWithAdditionalParameter.filePath,
            fullPathExpression)
            .then(mm => applyPassArgument(mm, requirement));
    }

    function applyPassArgument(matches: MatchResult[], requirement: PassArgumentRequirement): Report {
        if (matches.length === 0) {
            return reportUnimplemented(requirement, "Function not found");
        } else {
            matches.map(enclosingFunction => {
                const newValue = enclosingFunction.$value.replace(
                    new RegExp(requirement.functionWithAdditionalParameter + "\\s*\\(", "g"),
                    requirement.functionWithAdditionalParameter + `(${requirement.argumentValue}, `);
                enclosingFunction.$value = newValue;
            });
            return emptyReport;
        }
    }

    function pathExpressionToFunctionDeclaration(fn: FunctionIdentifier): string {

        const declarationOfInterest = `/Identifier[@value='${fn.name}'`;
        const functionDeclarationExpression = `//FunctionDeclaration[${declarationOfInterest}]]`;

        // TODO: handle ones with a namespace component.

        return functionDeclarationExpression;
    }

    function addParameter(project: Project, requirement: AddParameterRequirement): Promise<Report> {

        const functionDeclarationExpression = pathExpressionToFunctionDeclaration(requirement.functionWithAdditionalParameter);
        return findMatches(project, TypeScriptES6FileParser, requirement.functionWithAdditionalParameter.filePath,
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
                    const enclosingFunction = matches[0];
                    const enclosingFunctionName = childrenNamed(enclosingFunction, "Identifier")[0].$value;

                    const newValue = enclosingFunction.$value.replace(
                        new RegExp(enclosingFunctionName + "\\s*\\(", "g"),
                        `${enclosingFunctionName}(${requirement.parameterName}: ${requirement.parameterType}, `);
                    enclosingFunction.$value = newValue;
                    return emptyReport;
                }
            });
    }

    function childrenNamed(parent: TreeNode, name: string) {
        return parent.$children.filter(child => child.$name === name);
    }

}
