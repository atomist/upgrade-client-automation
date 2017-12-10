import { evaluateExpression } from "@atomist/tree-path/path/expressionEngine";
import { AddParameter } from "./AddParameter";

import { MatchResult } from "@atomist/automation-client/tree/ast/FileHits";


import { TypeScriptES6FileParser } from "@atomist/automation-client/tree/ast/typescript/TypeScriptFileParser";
import { findMatches } from "@atomist/automation-client/tree/ast/astUtils";
import { LocatedTreeNode } from "@atomist/automation-client/tree/LocatedTreeNode";
import { combineConsequences, concomitantChange, Consequences, emptyConsequences } from "./Consequences";


import { Project } from "@atomist/automation-client/project/Project";

import stringify = require("json-stringify-safe");
import { logger } from "@atomist/automation-client";
import { emptyReport, Report, reportImplemented, reportUnimplemented } from "./Report";

import { isSuccessResult } from "@atomist/tree-path/path/pathExpression";
import { AddImport } from "./manipulateImports";
import * as _ from "lodash";

import { TreeNode } from "@atomist/tree-path/TreeNode";



function consequencesOfFunctionCall(requirement: AddParameter.AddParameterRequirement,
                                    enclosingFunction: MatchResult): Consequences {

    const filePath = (enclosingFunction as LocatedTreeNode).sourceLocation.path;
    if (filePath.startsWith("test")) {
        return emptyConsequences;
    } // skip tests

    const enclosingFunctionName = identifier(enclosingFunction);

    const parameterExpression = `/SyntaxList/Parameter[/TypeReference[@value='${requirement.parameterType.name}']]/Identifier`;
    const suitableParameterMatches = evaluateExpression(enclosingFunction, parameterExpression);

    if (isSuccessResult(suitableParameterMatches) && suitableParameterMatches.length > 0) {
        const identifier = suitableParameterMatches[0];
        // these are locatable tree nodes, I can include a line number in the instruction! sourceLocation.lineFrom1
        logger.info("Found a call to %s inside a function called %s, with parameter %s",
            requirement.functionWithAdditionalParameter, enclosingFunctionName, identifier.$value);

        const instruction: AddParameter.PassArgumentRequirement = new AddParameter.PassArgumentRequirement({
            enclosingFunction: {
                enclosingScope: determineScope(enclosingFunction),
                name: enclosingFunctionName, filePath,
                access: determineAccess(enclosingFunction),
            },
            functionWithAdditionalParameter: requirement.functionWithAdditionalParameter,
            argumentValue: identifier.$value,
            why: requirement,
        });
        return concomitantChange(instruction);
    } else {
        logger.info("Found a call to %s inside a function called %s, no suitable parameter",
            requirement.functionWithAdditionalParameter, enclosingFunctionName);

        const passArgument: AddParameter.PassArgumentRequirement = new AddParameter.PassArgumentRequirement({
            enclosingFunction: {
                enclosingScope: determineScope(enclosingFunction),
                name: enclosingFunctionName, filePath,
                access: determineAccess(enclosingFunction),
            },
            functionWithAdditionalParameter: requirement.functionWithAdditionalParameter,
            argumentValue: requirement.parameterName,
            why: requirement,
        });
        const newParameterForMe: AddParameter.AddParameterRequirement = new AddParameter.AddParameterRequirement({
            functionWithAdditionalParameter: {
                enclosingScope: determineScope(enclosingFunction),
                name: enclosingFunctionName, filePath,
                access: determineAccess(enclosingFunction),
            },
            parameterType: requirement.parameterType,
            parameterName: requirement.parameterName,
            populateInTests: requirement.populateInTests,
            why: passArgument,
        });
        return { concomitantChanges: [passArgument], prerequisiteChanges: [newParameterForMe] };
    }
}

function determineAccess(fnDeclaration: MatchResult): AddParameter.Access {
    const access: AddParameter.Access = hasKeyword(fnDeclaration, "ExportKeyword") ?
        { kind: "PublicFunctionAccess" } :
        hasKeyword(fnDeclaration, "PrivateKeyword") || hasKeyword(fnDeclaration, "ProtectedKeyword") ?
            { kind: "PrivateMethodAccess" } :
            { kind: "PrivateFunctionAccess" };
    return access;
}

function hasKeyword(fnDeclaration: MatchResult, astElement: string): boolean {
    const keywordExpression = `/SyntaxList/${astElement}`;
    const ekm = evaluateExpression(fnDeclaration, keywordExpression);
    return ekm && ekm.length && true;
}


function propertyAccessExpression(s: AddParameter.EnclosingScope, soFar: string): string {
    if (s === undefined) {
        return soFar;
    }
    return propertyAccessExpression(s.enclosingScope, s.name + "." + soFar);
}

function functionCallPathExpression(fn: AddParameter.FunctionCallIdentifier) {
    if (AddParameter.isPrivateMethodAccess(fn.access)) {
        // this should be the last identifier, that is the fn.name, but I don't know how to express that
        return `//CallExpression[/PropertyAccessExpression/Identifier[@value='${fn.name}']]`;
    }
    if (fn.enclosingScope) {
        return `//CallExpression[/PropertyAccessExpression[@value='${propertyAccessExpression(fn.enclosingScope, fn.name)}']]`
    }
    return `//CallExpression[/Identifier[@value='${fn.name}']]`;
}


export function passArgument(project: Project, requirement: AddParameter.PassArgumentRequirement): Promise<Report> {

    const fullPathExpression = functionDeclarationPathExpression(requirement.enclosingFunction) +
        functionCallPathExpression(requirement.functionWithAdditionalParameter);

    return findMatches(project,
        TypeScriptES6FileParser,
        requirement.enclosingFunction.filePath,
        fullPathExpression)
        .then(mm => applyPassArgument({ matches: mm, requirement: requirement }));
}

function applyPassArgument(parameters: { matches: MatchResult[], requirement: AddParameter.PassArgumentRequirement }): Report {
    let { matches, requirement } = parameters;
    if (matches.length === 0) {
        logger.warn("No matches on " + stringify(requirement));
        return reportUnimplemented(requirement, "Function not found");
    } else {
        matches.map(enclosingFunction => {
            const openParen = requireExactlyOne(enclosingFunction.evaluateExpression("/OpenParenToken"),
                "wtf where is open paren");
            openParen.$value = `(${requirement.argumentValue}, `;
        });
        return reportImplemented(requirement);
    }
}


/*
* Implementation: find all the calls in the test sources and pass a dummy argument
*/
export function passDummyInTests(project: Project, requirement: AddParameter.PassDummyInTestsRequirement): Promise<Report> {
    return findMatches(project, TypeScriptES6FileParser, "test*/**/*.ts",
        functionCallPathExpression(requirement.functionWithAdditionalParameter))
        .then(matches => {
            if (matches.length === 0) {
                return []; // it's valid for there to be no changes
            } else {
                matches.map(functionCall => {
                    // TODO: replace the open paren token instead, it's cuter
                    const newValue = functionCall.$value.replace(
                        new RegExp(requirement.functionWithAdditionalParameter.name + "\\s*\\(", "g"),
                        `${requirement.functionWithAdditionalParameter.name}(${requirement.dummyValue}, `);
                    functionCall.$value = newValue;

                });
                return _.uniq(matches.map(m => (m as LocatedTreeNode).sourceLocation.path));
            }
        })
        .then(filesChanged => project.flush().then(() => filesChanged))
        .then(filesChanged => {
            if (filesChanged.length === 0) {
                return emptyReport
            } else {
                const addImportTo = requirement.additionalImport ? filesChanged : [];
                return Promise.all(addImportTo
                    .map(f => {
                        return AddImport.addImport(project, f, requirement.additionalImport)
                    }))
                    .then(() => reportImplemented(requirement));
            }
        })
}


export function addParameter(project: Project, requirement: AddParameter.AddParameterRequirement): Promise<Report> {
    return AddImport.addImport(project,
        requirement.functionWithAdditionalParameter.filePath,
        requirement.parameterType)
        .then(importAdded => {
            logger.info("Exercising path expression: " + functionDeclarationPathExpression(requirement.functionWithAdditionalParameter))
            return findMatches(project, TypeScriptES6FileParser, requirement.functionWithAdditionalParameter.filePath,
                functionDeclarationPathExpression(requirement.functionWithAdditionalParameter))
                .then(matches => {
                    if (matches.length === 0) {
                        logger.warn("Found 0 function declarations for " +
                            functionDeclarationPathExpression(requirement.functionWithAdditionalParameter) + " in " +
                            requirement.functionWithAdditionalParameter.filePath);
                        return reportUnimplemented(requirement, "Function declaration not found");
                    } else if (1 < matches.length) {
                        logger.warn("Doing Nothing; Found more than one function declaration at " + functionDeclarationPathExpression(requirement.functionWithAdditionalParameter));
                        return reportUnimplemented(requirement, "More than one function declaration matched. I'm confused.")
                    } else {
                        const functionDeclaration = matches[0];
                        const openParen = requireExactlyOne(functionDeclaration.evaluateExpression("/OpenParenToken"),
                            "wtf where is open paren");

                        openParen.$value = `(${requirement.parameterName}: ${requirement.parameterType.name}, `;
                        return reportImplemented(requirement);
                    }
                })
        });
}


export function determineScope(tn: TreeNode, topLevel?: AddParameter.EnclosingScope, baseScope?: AddParameter.EnclosingScope): AddParameter.EnclosingScope | undefined {
    if (!tn.$parent) {
        return baseScope;
    } else {
        switch (tn.$parent.$name) {
            case "ClassDeclaration":
                const thisLevel: AddParameter.ClassAroundMethod = {
                    kind: "class around method",
                    name: identifier(tn.$parent),
                    exported: true // TODO: really check
                };
                if (topLevel) {
                    topLevel.enclosingScope = thisLevel;
                }
                return determineScope(tn.$parent, thisLevel, baseScope || thisLevel);
            case "ModuleDeclaration":
                if (isNamespaceModule(tn.$parent)) {
                    const thisLevel: AddParameter.EnclosingNamespace = {
                        kind: "enclosing namespace",
                        name: identifier(tn.$parent),
                        exported: true // TODO: really check
                    };
                    if (topLevel) {
                        topLevel.enclosingScope = thisLevel;
                    }
                    return determineScope(tn.$parent, thisLevel, baseScope || thisLevel);
                } // else fall through
            default:
                // nothing interesting at this level
                return determineScope(tn.$parent, topLevel, baseScope);
        }
    }
}


function requireExactlyOne(m: TreeNode[], msg: string): TreeNode {
    if (!m || m.length != 1) {
        throw new Error(msg)
    }
    return m[0];
}

function identifier(parent: TreeNode): string {
    return childrenNamed(parent, "Identifier")[0].$value
}

function childrenNamed(parent: TreeNode, name: string) {
    return parent.$children.filter(child => child.$name === name);
}

function isNamespaceModule(tn: TreeNode): boolean {
    return tn.$children.some(c => c.$name === "ModuleBlock")
}


function scopePathExpressionComponents(s: AddParameter.EnclosingScope, soFar: string[] = []): string[] {
    if (s === undefined) {
        return soFar;
    }
    const component = AddParameter.isClassAroundMethod(s) ?
        `ClassDeclaration[/Identifier[@value='${s.name}']]` :
        `ModuleDeclaration[/Identifier[@value='${s.name}']]/ModuleBlock`;
    return [component].concat(soFar)
}

function functionDeclarationPathExpression(fn: AddParameter.FunctionCallIdentifier): AddParameter.PathExpression {
    const identification = `[/Identifier[@value='${fn.name}']]`;
    const methodOrFunction = fn.enclosingScope && AddParameter.isClassAroundMethod(fn.enclosingScope) ? "MethodDeclaration" : "FunctionDeclaration";

    const components = scopePathExpressionComponents(fn.enclosingScope).concat([methodOrFunction + identification]);
    return "//" + components.join("//");
}


export function findConsequencesOfAddParameter(project: Project, requirement: AddParameter.AddParameterRequirement): Promise<Consequences> {
    const passDummyInTests: AddParameter.PassDummyInTestsRequirement = new AddParameter.PassDummyInTestsRequirement({
        functionWithAdditionalParameter: requirement.functionWithAdditionalParameter,
        dummyValue: requirement.populateInTests.dummyValue,
        additionalImport: requirement.populateInTests.additionalImport,
    });

    // someday: if the access is private to a class, then the pxe should be narrowed from above
    // also, imports should narrow from above too
    const innerExpression = functionCallPathExpression(requirement.functionWithAdditionalParameter);
    const callWithinFunction = `//FunctionDeclaration[${innerExpression}]`;
    const callWithinMethod = `//MethodDeclaration[${innerExpression}]`;
    logger.info("Looking for calls in : " + callWithinMethod);
    logger.info("Looking for calls in : " + callWithinFunction);
    logger.info("looking in: " + AddParameter.globFromAccess(requirement.functionWithAdditionalParameter));

    const globalConsequences = AddParameter.isPublicFunctionAccess(requirement.functionWithAdditionalParameter.access) ?
        concomitantChange(passDummyInTests) : emptyConsequences;

    // in source, either find a parameter that fits, or receive it.
    return findMatches(project, TypeScriptES6FileParser, AddParameter.globFromAccess(requirement.functionWithAdditionalParameter),
        callWithinFunction + "|" + callWithinMethod)
        .then(matches => matches.reduce((cc, functionCallMatch) =>
                combineConsequences(cc, consequencesOfFunctionCall(requirement, functionCallMatch)),
            emptyConsequences))
        .then((srcConsequences: Consequences) => {
            return combineConsequences(srcConsequences, globalConsequences);
        });
}


