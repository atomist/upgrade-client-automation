import { AddMigrationRequirement } from "./AddMigrationRequirement";
import { Requirement } from "./TypescriptEditing";


import { TypeScriptES6FileParser } from "@atomist/automation-client/tree/ast/typescript/TypeScriptFileParser";
import { findMatches } from "@atomist/automation-client/tree/ast/astUtils";
import { combineConsequences, concomitantChange, Consequences, emptyConsequences } from "./Consequences";

import { TreeNode } from "@atomist/tree-path/TreeNode";

import { Project } from "@atomist/automation-client/project/Project";
import { logger } from "@atomist/automation-client";
import { AddImport } from "./manipulateImports";
import { evaluateExpression } from "@atomist/tree-path/path/expressionEngine";
import { isSuccessResult } from "@atomist/tree-path/path/pathExpression";
import {
    FunctionCallIdentifier, functionCallIdentifierFromTreeNode, functionCallPathExpression,
    functionDeclarationPathExpression, globFromAccess,
    isPublicFunctionAccess, qualifiedName,
    sameFunctionCallIdentifier,
} from "./functionCallIdentifier";
import { Report, reportImplemented, reportUnimplemented } from "./Report";
import { LocatedTreeNode } from "@atomist/automation-client/tree/LocatedTreeNode";
import { MatchResult } from "@atomist/automation-client/tree/ast/FileHits";
import { PassArgumentRequirement } from "./PassArgumentRequirement";
import { PassDummyInTestsRequirement } from "./PassDummyInTestRequirement";


export class AddParameterRequirement extends Requirement {
    public readonly kind: "Add Parameter" = "Add Parameter";

    public functionWithAdditionalParameter: FunctionCallIdentifier;
    public parameterType: AddImport.ImportIdentifier;
    public parameterName: string;
    public populateInTests: {
        dummyValue: string;
        additionalImport?: AddImport.ImportIdentifier;
    };

    constructor(params: {
        functionWithAdditionalParameter: FunctionCallIdentifier,
        parameterType: AddImport.ImportIdentifier,
        parameterName: string,
        populateInTests: {
            dummyValue: string;
            additionalImport?: AddImport.ImportIdentifier;
        },
        why?: any
    }) {
        super(params.why);
        this.functionWithAdditionalParameter = params.functionWithAdditionalParameter;
        this.parameterType = params.parameterType;
        this.parameterName = params.parameterName;
        this.populateInTests = params.populateInTests;
    }

    public sameRequirement(other: Requirement): boolean {
        return isAddParameterRequirement(other) &&
            sameFunctionCallIdentifier(this.functionWithAdditionalParameter, other.functionWithAdditionalParameter) &&
            this.parameterName === other.parameterName
    }

    public describe() {
        const r = this;
        return `Add parameter "${r.parameterName}: ${r.parameterType.name}" to ${qualifiedName(r.functionWithAdditionalParameter)}`
    }

    public findConsequences(project: Project) {
        return findConsequencesOfAddParameter(project, this);
    }

    public implement(project: Project) {
        return implementAddParameter(project, this);
    }
}


export function isAddParameterRequirement(r: Requirement): r is AddParameterRequirement {
    return r.kind === "Add Parameter";
}


function findConsequencesOfAddParameter(project: Project, requirement: AddParameterRequirement): Promise<Consequences> {
    const passDummyInTests: PassDummyInTestsRequirement = new PassDummyInTestsRequirement({
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
    logger.info("looking in: " + globFromAccess(requirement.functionWithAdditionalParameter));

    const testConsequences = isPublicFunctionAccess(requirement.functionWithAdditionalParameter.access) ?
        concomitantChange(passDummyInTests) : emptyConsequences;
    const externalConsequences = concomitantChange(new AddMigrationRequirement(requirement, requirement));
    const globalConsequences = combineConsequences(testConsequences, externalConsequences);

    // in source, either find a parameter that fits, or receive it.
    return findMatches(project, TypeScriptES6FileParser, globFromAccess(requirement.functionWithAdditionalParameter),
        callWithinFunction + "|" + callWithinMethod)
        .then(matches => matches.reduce((cc, functionCallMatch) =>
                combineConsequences(cc, consequencesOfFunctionCall(requirement, functionCallMatch)),
            emptyConsequences))
        .then((srcConsequences: Consequences) => {
            return combineConsequences(srcConsequences, globalConsequences);
        });
}


export function consequencesOfFunctionCall(requirement: AddParameterRequirement,
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

        const instruction: PassArgumentRequirement = new PassArgumentRequirement({
            enclosingFunction: functionCallIdentifierFromTreeNode(enclosingFunction),
            functionWithAdditionalParameter: requirement.functionWithAdditionalParameter,
            argumentValue: identifier.$value,
            why: requirement,
        });
        return concomitantChange(instruction);
    } else {
        logger.info("Found a call to %s inside a function called %s, no suitable parameter",
            requirement.functionWithAdditionalParameter, enclosingFunctionName);

        const passArgument: PassArgumentRequirement = new PassArgumentRequirement({
            enclosingFunction: functionCallIdentifierFromTreeNode(enclosingFunction),
            functionWithAdditionalParameter: requirement.functionWithAdditionalParameter,
            argumentValue: requirement.parameterName,
            why: requirement,
        });
        const newParameterForMe: AddParameterRequirement = new AddParameterRequirement({
            functionWithAdditionalParameter: functionCallIdentifierFromTreeNode(enclosingFunction),
            parameterType: requirement.parameterType,
            parameterName: requirement.parameterName,
            populateInTests: requirement.populateInTests,
            why: passArgument,
        });
        return { concomitantChanges: [passArgument], prerequisiteChanges: [newParameterForMe] };
    }
}







function implementAddParameter(project: Project, requirement: AddParameterRequirement): Promise<Report> {
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


function requireExactlyOne<A>(m: TreeNode[], msg: string): TreeNode {
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