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

import { InMemoryProject } from "@atomist/automation-client/project/mem/InMemoryProject";
import * as stringify from "json-stringify-safe";
import "mocha";
import * as assert from "power-assert";
import { applyRequirement } from "../../src/typescriptEditing/editor";

import { logger } from "@atomist/automation-client";
import { GitCommandGitProject } from "@atomist/automation-client/project/git/GitCommandGitProject";
import { NodeFsLocalProject } from "@atomist/automation-client/project/local/NodeFsLocalProject";
import { Project } from "@atomist/automation-client/project/Project";
import { findMatches } from "@atomist/automation-client/tree/ast/astUtils";
import { TypeScriptES6FileParser } from "@atomist/automation-client/tree/ast/typescript/TypeScriptFileParser";
import { TreeNode } from "@atomist/tree-path/TreeNode";
import * as appRoot from "app-root-path";
import * as _ from "lodash";
import { LibraryImport } from "../../src/typescriptEditing/addImport";
import {
    AddMigrationRequirement,
    isAddMigrationRequirement,
} from "../../src/typescriptEditing/AddMigrationRequirement";
import {
    AddParameterRequirement,
    isAddParameterRequirement,
} from "../../src/typescriptEditing/AddParameterRequirement";
import { Changeset, describeChangeset } from "../../src/typescriptEditing/Changeset";
import {
    FunctionCallIdentifier, isPublicFunctionAccess,
    isPublicMethodAccess,
} from "../../src/typescriptEditing/functionCallIdentifier";
import {
    functionCallIdentifierFromProject,
    methodInClass, topLevelFunction,
} from "../../src/typescriptEditing/functionCallIdentifierFromProject";
import {
    isPassArgumentRequirement,
    PassArgumentRequirement,
} from "../../src/typescriptEditing/PassArgumentRequirement";
import {
    isPassDummyInTests,
    PassDummyInTestsRequirement,
} from "../../src/typescriptEditing/PassDummyInTestRequirement";
import { Report } from "../../src/typescriptEditing/Report";
import {
    changesetForRequirement, implement, Requirement,
    sameRequirement,
} from "../../src/typescriptEditing/TypescriptEditing";

function addParameterRequirement(fci: Partial<FunctionCallIdentifier>): AddParameterRequirement {
    const fullFci: FunctionCallIdentifier = {
        access: { kind: "PublicFunctionAccess" },
        ...fci,
    } as FunctionCallIdentifier;
    return new AddParameterRequirement({
        functionWithAdditionalParameter: fullFci,
        parameterType: { kind: "library", name: "HandlerContext", location: "@atomist/automation-client" },
        parameterName: "context",
        populateInTests: {
            dummyValue: "{}",
        },
    });
}

describe("detection of consequences", () => {

    function allRequirements(changeset: Changeset): Requirement[] {
        return _.flatMap(changeset.prerequisites, cs => allRequirements(cs)).concat(changeset.requirements);
    }

    describe("Add Parameter leads to populating dummy in tests", () => {

        it("should only pass dummy in test/ when Add Parameter is called", done => {

            const fileToNotChange = "test/funciton.ts";
            const fileToChange = "src/funciton.ts";
            const input = InMemoryProject.of({
                    path: fileToNotChange,
                    content: `
        export function iShouldChange() {
            return privateFunciton("yarrr");
        }

        function privateFunciton(s: string) {
           logger.info("give me your context! I need it!");
        }\n`,
                },
                {
                    path: fileToChange,
                    content: `
        export function iShouldChange() {
            return privateFunciton("yarrr");
        }

        function privateFunciton(s: string) {
           logger.info("give me your context! I need it!");
        }\n`,
                },
            );

            const addParameterPublicRequirement: Requirement = addParameterRequirement({
                name: "privateFunciton",
                filePath: "src/DoesntMatter.ts",
            });

            changesetForRequirement(input, addParameterPublicRequirement)
                .then(allRequirements)
                .then(consequences => {
                    assert(consequences.some(c => isPassDummyInTests(c)));
                    assert(!consequences.some(c => {
                        return isAddParameterRequirement(c) && c.functionWithAdditionalParameter.filePath === fileToNotChange;
                    }), stringify(consequences, null, 2));
                    assert(!consequences.some(c => {
                        return isPassArgumentRequirement(c) && c.enclosingFunction.filePath === fileToNotChange;
                    }), stringify(consequences, null, 2));
                })
                .then(() => done(), done);
        });

        it("when Add Parameter to a private function, don't pass dummy in tests", done => {

            const fileToChange = "src/funciton.ts";
            const input = InMemoryProject.of({
                    path: fileToChange,
                    content: `
        function iShouldChange() {
            return privateFunciton("yarrr");
        }

        function privateFunciton(s: string) {
           logger.info("give me your context! I need it!");
        }\n`,
                },
            );

            const addParameterPrivateRequirement: Requirement = addParameterRequirement({
                name: "privateFunciton",
                filePath: "src/DoesntMatter.ts",
                access: { kind: "PrivateFunctionAccess" },
            });

            changesetForRequirement(input, addParameterPrivateRequirement)
                .then(allRequirements)
                .then(consequences => {
                    assert(!consequences.some(c =>
                        c.kind === "Pass Dummy In Tests",
                    ));
                })
                .then(() => done(), done);
        });
    });

    describe("Add Parameter leads to passing an argument to calls to that function", () => {

        it("when a function with a new parameter is not exported, calls to the same-name function in another file are not affected", done => {

            const fileToNotChange = "src/notFunciton.ts";
            const fileToChange = "src/funciton.ts";
            const input = InMemoryProject.of({
                    path: fileToNotChange,
                    content: `
        export function thinger() {
            return privateFunciton("and stuff");
        }

        function privateFunciton(s: string) {
           logger.info("this is mine, it is not changing");
        }\n`,
                },
                {
                    path: fileToChange,
                    content: `
        export function iShouldChange() {
            return privateFunciton("yarrr");
        }

         function privateFunciton(s: string) {
           logger.info("give me your context! I need it!");
        }
`,
                },
            );

            const original: Requirement = addParameterRequirement({
                name: "privateFunciton",
                filePath: fileToChange,
                access: { kind: "PrivateFunctionAccess" },
            });

            changesetForRequirement(input, original)
                .then(allRequirements)
                .then(all => {
                    assert(!all.some(c => isPassArgumentRequirement(c) && c.enclosingFunction.filePath === fileToNotChange));
                    return all;
                })
                .then(all => all.filter(a => isAddParameterRequirement(a)) as AddParameterRequirement[])
                .then(addParameterConsequences => {
                    assert(addParameterConsequences.some(c =>
                        c.functionWithAdditionalParameter.name === "iShouldChange"
                        && c.functionWithAdditionalParameter.access.kind === "PublicFunctionAccess",
                    ), stringify(addParameterConsequences, null, 2));
                    assert(!addParameterConsequences.some(c => c.functionWithAdditionalParameter.filePath === fileToNotChange),
                        stringify(addParameterConsequences, null, 2));
                })
                .then(() => done(), done);
        });

        it("finds calls inside a class method", done => {
            const fileOfInterest = "src/Classy.ts";
            const input = InMemoryProject.of({
                path: fileOfInterest, content: `
        class Classy {
            protected thinger() {
                return giveMeYourContext("and stuff");
            }
        }\n`,
            });

            const original: Requirement = addParameterRequirement({
                name: "giveMeYourContext",
                filePath: "src/DoesntMatter.ts",
            });

            printStructureOfFile(input, fileOfInterest)
                .then(() => changesetForRequirement(input, original))
                .then(allRequirements)
                .then(consequences => {
                    assert(consequences.some(c =>
                        isPassArgumentRequirement(c) && c.enclosingFunction.enclosingScope.name === "Classy"));
                })
                .then(() => done(), done);
        });

        it("finds transitive calls when the method is in a namespace", done => {
            const fileOfInterest = "src/Classy.ts";
            const input = InMemoryProject.of({
                path: fileOfInterest, content: `
        class Classy {
            public static thinger() {
                return Spacey.giveMeYourContext("and stuff");
            }
        }

        class Clicker {
            protected clickMe() {
                return Classy.thinger();
            }
        }\n`,
            });

            const original: Requirement = addParameterRequirement({
                enclosingScope: { kind: "enclosing namespace", name: "Spacey", exported: true },
                name: "giveMeYourContext",
                filePath: "src/DoesntMatter.ts",
            });

            printStructureOfFile(input, fileOfInterest)
                .then(() => changesetForRequirement(input, original))
                .then(allRequirements)
                .then(consequences => {
                    assert(consequences.some(c => isPassArgumentRequirement(c) && c.enclosingFunction.enclosingScope.name === "Classy"),
                        stringify(consequences, null, 2));
                    assert(consequences.some(c => isPassArgumentRequirement(c) && c.enclosingFunction.enclosingScope.name === "Clicker"),
                        stringify(consequences, null, 2));
                })
                .then(() => done(), done);
        });

        it("finds calls to private methods inside the class", done => {
            const fileOfInterest = "src/Classy.ts";
            const input = InMemoryProject.of({
                path: fileOfInterest, content: `
        class Classy {

           public otherThinger(params: P, ctx: HandlerContext) {
               return this.thinger();
           }

           private thinger() {
                return Spacey.giveMeYourContext("and stuff");
           }
        }\n`,
            });

            const original: Requirement = addParameterRequirement({
                enclosingScope: { kind: "class around method", name: "Classy", exported: true },
                name: "thinger",
                filePath: fileOfInterest,
                access: { kind: "PrivateMethodAccess" },
            });

            printStructureOfFile(input, fileOfInterest)
                .then(() => changesetForRequirement(input, original)
                    .then(allRequirements))
                .then(consequences => {
                    const c = consequences.find(c => isPassArgumentRequirement(c) &&
                        c.enclosingFunction.enclosingScope.name === "Classy" &&
                        c.enclosingFunction.name === "otherThinger" &&
                        c.functionWithAdditionalParameter.name === "thinger") as PassArgumentRequirement;
                    assert(c,
                        stringify(consequences, null, 2));
                    assert(c.argumentValue === "ctx");
                })
                .then(() => done(), done);
        });

    });

    describe("Add Parameter on a public function/method leads to a migration", () => {

        it("Requests a new migration when an exported function is changed", done => {
            const fileOfInterest = "src/thinger.ts";
            const input = InMemoryProject.of({
                path: fileOfInterest, content: `
        export function thinger() {
            return "something about your context";
        }\n`,
            });

            const original: Requirement = new AddParameterRequirement({
                functionWithAdditionalParameter: {
                    name: "thinger",
                    filePath: fileOfInterest,
                    access: { kind: "PublicFunctionAccess" },
                },
                parameterType: {
                    kind: "local", name: "HandlerContext", localPath: "../HandlerContext.ts",
                    externalPath: "@atomist/automation-client",
                },
                parameterName: "context",
                populateInTests: {
                    dummyValue: "{}",
                },
            });

            changesetForRequirement(input, original)
                .then(cs => cs.requirements) // in the same changeset
                .then(consequences => {
                    const amr = consequences.find(c => isAddMigrationRequirement(c)) as AddMigrationRequirement;
                    assert(amr);

                    const inner = amr.downstreamRequirement;
                    assert(isAddParameterRequirement(inner));

                    const apr = inner as AddParameterRequirement;
                    assert((apr.parameterType as LibraryImport).location === "@atomist/automation-client");
                })
                .then(() => done(), done);
        });

        it("Does not request a migration for a private function", done => {
            const fileOfInterest = "src/thinger.ts";
            const input = InMemoryProject.of({
                path: fileOfInterest, content: `
        function thinger() {
            return "something about your context";
        }\n`,
            });

            const original: Requirement = new AddParameterRequirement({
                functionWithAdditionalParameter: {
                    name: "thinger",
                    filePath: fileOfInterest,
                    access: { kind: "PrivateFunctionAccess" },
                },
                parameterType: {
                    kind: "local", name: "HandlerContext", localPath: "../HandlerContext.ts",
                    externalPath: "@atomist/automation-client",
                },
                parameterName: "context",
                populateInTests: {
                    dummyValue: "{}",
                },
            });

            changesetForRequirement(input, original)
                .then(cs => cs.requirements) // in the same changeset
                .then(consequences => {
                    const amr = consequences.find(c => isAddMigrationRequirement(c)) as AddMigrationRequirement;
                    assert(!amr);
                })
                .then(() => done(), done);

        });

        it("Locates the import path for the downstream project to use");

        it("Requests a migration for a public method in a public class", done => {
            const fileOfInterest = "src/Classy.ts";
            const input = InMemoryProject.of({
                path: fileOfInterest, content: `
class Classy {
    public thinger() {
       return "something about your context";
    }
}\n`,
            });
            functionCallIdentifierFromProject(input,
                fileOfInterest, methodInClass("Classy", "thinger"))
                .then(functionOfInterest => {

                    assert(isPublicMethodAccess(functionOfInterest.access), stringify(functionOfInterest));

                    const original: Requirement = new AddParameterRequirement({
                        functionWithAdditionalParameter: functionOfInterest,
                        parameterType: {
                            kind: "local", name: "HandlerContext", localPath: "../HandlerContext.ts",
                            externalPath: "@atomist/automation-client",
                        },
                        parameterName: "context",
                        populateInTests: {
                            dummyValue: "{}",
                        },
                    });

                    return changesetForRequirement(input, original)
                        .then(cs => cs.requirements) // in the same changeset
                        .then(consequences => {
                            const amr = consequences.find(c => isAddMigrationRequirement(c)) as AddMigrationRequirement;
                            assert(amr);

                            const inner = amr.downstreamRequirement;
                            assert(isAddParameterRequirement(inner));

                            const apr = inner as AddParameterRequirement;
                            assert((apr.parameterType as LibraryImport).location === "@atomist/automation-client");
                        });
                })
                .then(() => done(), done);

        });

        it("Does not request a migration for a private method", done => {
            const fileOfInterest = "src/Classy.ts";
            const input = InMemoryProject.of({
                path: fileOfInterest, content: `
class Classy {
    private thinger() {
       return "something about your context";
    }
}\n`,
            });
            functionCallIdentifierFromProject(input,
                fileOfInterest, methodInClass("Classy", "thinger"))
                .then(functionOfInterest => {

                    const original: Requirement = new AddParameterRequirement({
                        functionWithAdditionalParameter: functionOfInterest,
                        parameterType: {
                            kind: "local", name: "HandlerContext", localPath: "../HandlerContext.ts",
                            externalPath: "@atomist/automation-client",
                        },
                        parameterName: "context",
                        populateInTests: {
                            dummyValue: "{}",
                        },
                    });

                    return changesetForRequirement(input, original)
                        .then(cs => cs.requirements) // in the same changeset
                        .then(consequences => {
                            const amr = consequences.find(c => isAddMigrationRequirement(c)) as AddMigrationRequirement;
                            assert(!amr);
                        });
                })
                .then(() => done(), done);

        });
    });

    describe("properties of enclosing functions", () => {

        it("detects an exported function and calls it public", done => {
            const fileOfInterest = "src/Classy.ts";
            const input = InMemoryProject.of({
                path: fileOfInterest, content: `
        export function thinger() {
            return giveMeYourContext("and stuff");
        }\n`,
            });

            const original: Requirement = addParameterRequirement({
                name: "giveMeYourContext",
                filePath: "src/DoesntMatter.ts",
            });

            printStructureOfFile(input, fileOfInterest)
                .then(() => changesetForRequirement(input, original)
                    .then(allRequirements))
                .then(consequences => {
                    assert(consequences.some(c => {
                        return isAddParameterRequirement(c) && c.functionWithAdditionalParameter.name === "thinger"
                            && c.functionWithAdditionalParameter.access.kind === "PublicFunctionAccess";
                    }));
                })
                .then(() => done(), done);
        });

        it("detects a not-exported function and calls it private", done => {
            const fileOfInterest = "src/Classy.ts";
            const input = InMemoryProject.of({
                path: fileOfInterest, content: `
        function thinger() {
            return giveMeYourContext("and stuff");
        }\n`,
            });

            const original: Requirement =
                addParameterRequirement({
                    name: "giveMeYourContext",
                    filePath: "src/DoesntMatter.ts",
                });

            printStructureOfFile(input, fileOfInterest)
                .then(() => changesetForRequirement(input, original)
                    .then(allRequirements))
                .then(consequences => {
                    const consequenceOfInterest: AddParameterRequirement = consequences.find(c =>
                        isAddParameterRequirement(c) && c.functionWithAdditionalParameter.name === "thinger") as AddParameterRequirement;
                    assert(consequenceOfInterest);
                    assert.equal(consequenceOfInterest.functionWithAdditionalParameter.access.kind, "PrivateFunctionAccess");
                })
                .then(() => done(), done);
        });

        it("detects a private method", done => {
            const fileOfInterest = "src/Classy.ts";
            const input = InMemoryProject.of({
                path: fileOfInterest, content: `
        class Classy {

           public otherThinger(context: HandlerContext) {
               return this.thinger();
           }

           private thinger() {
                return Spacey.giveMeYourContext("and stuff");
           }
        }\n`,
            });

            const original: Requirement =
                addParameterRequirement({
                    enclosingScope: { kind: "enclosing namespace", name: "Spacey", exported: true },
                    name: "giveMeYourContext",
                    filePath: "src/DoesntMatter.ts",
                });

            printStructureOfFile(input, fileOfInterest)
                .then(() => changesetForRequirement(input, original)
                    .then(allRequirements))
                .then(consequences => {
                    const consequenceOfInterest: AddParameterRequirement = consequences.find(c =>
                        isAddParameterRequirement(c) && c.functionWithAdditionalParameter.name === "thinger") as AddParameterRequirement;
                    assert(consequenceOfInterest);
                    assert.equal(consequenceOfInterest.functionWithAdditionalParameter.access.kind, "PrivateMethodAccess");
                })
                .then(() => done(), done);
        });

        it("detects a protected method, and calls it private for now", done => {
            const fileOfInterest = "src/Classy.ts";
            const input = InMemoryProject.of({
                path: fileOfInterest, content: `
        class Classy {

           public otherThinger(context: HandlerContext) {
               return this.thinger();
           }

           protected thinger() {
                return Spacey.giveMeYourContext("and stuff");
           }
        }\n`,
            });

            const original: Requirement =
                addParameterRequirement({
                    enclosingScope: { kind: "enclosing namespace", name: "Spacey", exported: true },
                    name: "giveMeYourContext",
                    filePath: "src/DoesntMatter.ts",
                });

            printStructureOfFile(input, fileOfInterest)
                .then(() => changesetForRequirement(input, original)
                    .then(allRequirements))
                .then(consequences => {
                    const consequenceOfInterest: AddParameterRequirement = consequences.find(c =>
                        isAddParameterRequirement(c) && c.functionWithAdditionalParameter.name === "thinger") as AddParameterRequirement;
                    assert(consequenceOfInterest);
                    assert.equal(consequenceOfInterest.functionWithAdditionalParameter.access.kind, "PrivateMethodAccess");
                })
                .then(() => done(), done);
        });

    });

    it("returns the original requirement", done => {
        const input = copyOfBefore();

        const original: Requirement = addParameterRequirement({
            name: "exportedDoesNotYetHaveContext",
            filePath: "src/CodeThatUsesIt.ts",
        });

        changesetForRequirement(input, original)
            .then(allRequirements)
            .then(consequences => {
                assert(consequences.some(o => sameRequirement(o, original)));
            }).then(() => done(), done);
    });

    it("can find calls to functions that aren't qualified names", done => {
        const thisProject = new NodeFsLocalProject("automation-client",
            appRoot.path + "/test/typescriptEditing/resources/before");

        changesetForRequirement(thisProject, addParameterRequirement({
            name: "exportedDoesNotYetHaveContext",
            filePath: "src/CodeThatUsesIt.ts",
        }))
            .then(allRequirements)
            .then(consequences => {
                assert.equal(consequences.length, 9, stringify(consequences));
            })
            .then(() => done(), done);
    });

    it("looks at many levels, in multiple files", done => {
        const thisProject = new NodeFsLocalProject("automation-client",
            appRoot.path + "/test/typescriptEditing/resources/before");

        changesetForRequirement(thisProject, addParameterRequirement({
            enclosingScope: { kind: "enclosing namespace", name: "InHere", exported: true },
            name: "giveMeYourContext",
            filePath: "src/CodeThatUsesIt.ts",
        }))
            .then(allRequirements)
            .then(consequences => {

                const addParameterAtHigherLevel = consequences.find(c =>
                    isAddParameterRequirement(c) &&
                    c.functionWithAdditionalParameter.name === "usesAFunctionThatDoesNotHaveContextAndDoesNotHaveContext");

                assert(addParameterAtHigherLevel, stringify(consequences.filter(isAddParameterRequirement), null, 2));

                const addParameterAtEvenHigherLevel = consequences.find(c =>
                    isAddParameterRequirement(c) &&
                    c.functionWithAdditionalParameter.name === "andEvenMoreStuff");

                assert(addParameterAtEvenHigherLevel);

                assert.equal(consequences.length,
                    18, // plausible
                    stringify(consequences, null, 2));
            })
            .then(() => done(), done);
    }).timeout(20000);

    it("helps me out", done => {
        const thisProject = new NodeFsLocalProject("automation-client",
            appRoot.path + "/test/typescriptEditing/resources/before");

        const innerExpression = `/Identifier[@value='usesAFunctionThatDoesNotHaveContext']`;

        findMatches(thisProject, TypeScriptES6FileParser, "src/CodeThatUsesIt.ts",
            `/SourceFile`)
            .then(matches => {
                    matches.forEach(m => {
                            logger.info(printMatch(m).join("\n"));

                            const source = matches[0];
                            const existingImport = source.evaluateExpression(
                                `//ImportDeclaration//Identifier[@value='HandlerContext']`);
                            logger.info("wtf does this return: " + existingImport.length);
                        },
                    );
                },
            ).then(() => done(), done);

    });
});

describe("pass argument", () => {

    it("finds calls inside methods", done => {
        const fileOfInterest = "src/project/diff/DifferenceEngine.ts";
        const input = InMemoryProject.of(
            {
                path: fileOfInterest, content: `export class DifferenceEngine {

    private cloneRepo(githubIssueAuth: GithubIssueAuth, sha: string): Promise<GitProject> {
        return GitCommandGitProject.cloned(
            {token: githubIssueAuth.githubToken},
                new GitHubRepoRef(githubIssueAuth.owner, githubIssueAuth.repo, githubIssueAuth.sha));
    }
}
             `,
            });

        const instruction: PassArgumentRequirement = new PassArgumentRequirement({
            enclosingFunction: {
                enclosingScope: { kind: "class around method", name: "DifferenceEngine", exported: true },
                name: "cloneRepo",
                filePath: "src/project/diff/DifferenceEngine.ts",
                access: { kind: "PublicFunctionAccess" }, // TODO: inaccurate
            },
            functionWithAdditionalParameter: {
                enclosingScope: {
                    kind: "class around method",
                    name: "GitCommandGitProject",
                    exported: true,
                },
                name: "cloned",
                filePath: "src/project/git/GitCommandGitProject.ts",
                access: { kind: "PublicFunctionAccess" },
            },
            argumentValue: "context",
        });

        printStructureOfFile(input, "src/project/diff/DifferenceEngine.ts").then(() =>
            implement(input, instruction).then(() => input.flush())
                .then(() => {
                    const after = input.findFileSync("src/project/diff/DifferenceEngine.ts").getContentSync();
                    assert(after.includes("cloned(context, "), after);
                }))
            .then(() => done(), done);
    });

    it("print path of match", done => {
        const fileOfInterest = "src/project/diff/DifferenceEngine.ts";
        const input = InMemoryProject.of(
            {
                path: fileOfInterest, content: `export class DifferenceEngine {

    private cloneRepo(githubIssueAuth: GithubIssueAuth, sha: string): Promise<GitProject> {
        return GitCommandGitProject.cloned(
            {token: githubIssueAuth.githubToken},
                new GitHubRepoRef(githubIssueAuth.owner, githubIssueAuth.repo, githubIssueAuth.sha));
    }
}
             `,
            });

        pathOfMatch(input, fileOfInterest).then(paths => {
                const expectedPath = "//ClassDeclaration[/Identifier[@value='DifferenceEngine']]//MethodDeclaration[/Identifier[@value='cloneRepo']]";
                assert.deepEqual([expectedPath], paths);
                return findMatches(input, TypeScriptES6FileParser, fileOfInterest,
                    paths[0]).then(matches => {
                    assert.equal(identifier(matches[0]), "cloneRepo");
                });
            },
        )
            .then(() => done(), done);
    });
});

function identifier(parent: TreeNode): string {
    return childrenNamed(parent, "Identifier")[0].$value;
}

function childrenNamed(parent: TreeNode, name: string) {
    return parent.$children.filter(child => child.$name === name);
}

/* this is for play */
function pathOfMatch(project: Project, path: string): Promise<string[]> {
    return findMatches(project, TypeScriptES6FileParser, path,
        `/SourceFile//ClassDeclaration//MethodDeclaration`)
        .then(matches => {
            return matches.map(m => {
                return guessPathExpression(m);
            });
        });
}

export function guessPathExpression(tn: TreeNode): string {
    return "//" + printMatchHierarchy(tn).reverse().join("//");
}

function printMatchHierarchy(m: TreeNode, hierarchy: TreeNode[] = []): string[] {
    hierarchy.push(m);
    if (m.$parent) {
        return printMatchHierarchy(m.$parent, hierarchy);
    } else {
        return _.compact(hierarchy.map(tn => {
            const identifier = tn.$children.find(c => c.$name === "Identifier");
            if (identifier) {
                const identifierTest = `[/Identifier[@value='${identifier.$value}']]`;
                return `${tn.$name}${identifierTest}`;
            } else {
                return undefined;
            }
        }));
    }
}

describe("populating dummy in test", () => {

    it("adds an additional import", done => {
        const fileOfInterest = "test/Something.ts";
        const input = InMemoryProject.of(
            {
                path: fileOfInterest, content: `import \"mocha\";\n

             myFunction();
             `,
            });

        const instruction: PassDummyInTestsRequirement = new PassDummyInTestsRequirement({
            functionWithAdditionalParameter: {
                name: "myFunction", filePath: "doesntmatter",
                access: { kind: "PublicFunctionAccess" },
            },
            dummyValue: "{} as HandlerContext",
            additionalImport: {
                kind: "library", name: "HandlerContext",
                location: "@atomist/automation-client",
            },
        });

        implement(input, instruction).then(() => input.flush())
            .then(() => {
                const after = input.findFileSync(fileOfInterest).getContentSync();
                assert(after.includes("import { HandlerContext } "), after);
            })
            .then(() => done(), done);
    });

    it("passes the dummy to method calls", done => {
        const fileOfInterest = "test/Something.ts";
        const input = InMemoryProject.of(
            {
                path: fileOfInterest, content: `import \"mocha\";\n

              it("should run repos query and clone repo", done => {
                const repo1 = org.repo[0];
                return GitCommandGitProject.cloned({ token: GitHubToken },
                    new GitHubRepoRef(repo1.owner, repo1.name))
                    .then(p => {
                        const gitHead = p.findFileSync(".git/HEAD");
                        assert(gitHead);
                        assert(gitHead.path === ".git/HEAD");
                    });
              });
             `,
            });

        const instruction: PassDummyInTestsRequirement = new PassDummyInTestsRequirement({
            functionWithAdditionalParameter: {
                enclosingScope: {
                    kind: "class around method",
                    name: "GitCommandGitProject",
                    exported: true,
                },
                name: "cloned",
                filePath: "src/project/git/GitCommandGitProject.ts",
                access: { kind: "PublicFunctionAccess" },
            },
            dummyValue: "{} as HandlerContext",
            additionalImport: {
                kind: "library", name: "HandlerContext",
                location: "@atomist/automation-client",
            },
        });

        implement(input, instruction).then(() => input.flush())
            .then(() => {
                const after = input.findFileSync(fileOfInterest).getContentSync();
                assert(after.includes("GitCommandGitProject.cloned({} as HandlerContext"), after);
            })
            .then(() => done(), done);
    });
});

function printStructureOfFile(project: Project, path: string) {
    return findMatches(project, TypeScriptES6FileParser, path,
        `/SourceFile`)
        .then(matches => {
            matches.forEach(m => {
                logger.info(printMatch(m).join("\n"));
            });
        });
}

function copyOfBefore() {
    const thisProject = new NodeFsLocalProject("automation-client",
        appRoot.path + "/test/typescriptEditing/resources/before");
    return InMemoryProject.of(
        thisProject.findFileSync("src/CodeThatUsesIt.ts"),
        thisProject.findFileSync("src/AdditionalFileThatUsesStuff.ts"));
}

describe("Adding a parameter", () => {

    it("adds it to the real one", done => {
        const fileOfInterest = "src/project/git/GitCommandGitProject.ts";
        const realProject = new NodeFsLocalProject("automation-client",
            "/Users/jessitron/code/atomist/automation-client-ts");
        const input = InMemoryProject.of(
            realProject.findFileSync(fileOfInterest));

        const addParameterInstruction: AddParameterRequirement = new AddParameterRequirement({
            functionWithAdditionalParameter: {
                enclosingScope: { kind: "class around method", name: "GitCommandGitProject", exported: true },
                name: "cloned",
                filePath: "src/project/git/GitCommandGitProject.ts",
                access: { kind: "PublicFunctionAccess" },
            },
            parameterName: "context",
            parameterType: {
                kind: "local",
                name: "HandlerContext",
                localPath: "src/HandlerContext",
            },
            populateInTests: {
                dummyValue: "{} as HandlerContext",
                additionalImport: {
                    kind: "local",
                    name: "HandlerContext",
                    localPath: "src/HandlerContext",
                },
            },
        });

        implement(input, addParameterInstruction).then(report => {
            logger.info(stringify(report, null, 2));
            //return printStructureOfFile(input, fileOfInterest);
        }).then(() => input.flush())
            .then(() => {
                const after = input.findFileSync(fileOfInterest).getContentSync();
                assert(after.includes(
                    `import { HandlerContext } from "../../HandlerContext"`),
                    after.split("\n")[0]);
                assert(after.includes("public static cloned(context: HandlerContext"), after);
            }).then(() => done(), done);

    });

    it("finds the function inside a class", done => {
        const fileOfInterest = "src/Classy.ts";
        const input = InMemoryProject.of({
            path: fileOfInterest, content:
                `class Classy {
        public static giveMeYourContext(stuff: string) { }
        }
        `,
        });

        const addParameterInstruction: AddParameterRequirement = addParameterRequirement(
            {
                enclosingScope: {
                    kind: "class around method",
                    name: "Classy",
                    exported: true,
                },
                name: "giveMeYourContext", filePath: fileOfInterest,
            });

        implement(input, addParameterInstruction).then(report => {
            logger.info(stringify(report, null, 2));
            return printStructureOfFile(input, fileOfInterest).then(() =>
                findMatches(input, TypeScriptES6FileParser, "src/Classy.ts",
                    "//ClassDeclaration[/Identifier[@value='Classy']]//MethodDeclaration[/Identifier[@value='giveMeYourContext']]"))
                .then(m => logger.info("found " + m.length));
        }).then(() => input.flush())
            .then(() => {
                const after = input.findFileSync(fileOfInterest).getContentSync();
                assert(after.includes("public static giveMeYourContext(context: HandlerContext, stuff: string)"), after);
            }).then(() => done(), done);

    });

    it("finds the function inside a namespace", done => {
        const fileOfInterest = "src/Spacey.ts";
        const input = InMemoryProject.of({
            path: fileOfInterest, content:
                `namespace Spacey {
        export function giveMeYourContext(stuff: string) { }
        }
`,
        });

        const addParameterInstruction: AddParameterRequirement = addParameterRequirement({
            enclosingScope: { kind: "enclosing namespace", name: "Spacey", exported: true },
            name: "giveMeYourContext",
            filePath: fileOfInterest,
        });

        implement(input, addParameterInstruction).then(report => {
            logger.info(stringify(report, null, 2));
            return printStructureOfFile(input, fileOfInterest);
        }).then(() => input.flush())
            .then(() => {
                const after = input.findFileSync(fileOfInterest).getContentSync();
                assert(after.includes("export function giveMeYourContext(context: HandlerContext, stuff: string)"), after);
            }).then(() => done(), done);

    });

    it("Adds the right type", done => {
        const input = copyOfBefore();
        implement(input, addParameterRequirement({
            name: "andEvenMoreStuff", filePath: "src/AdditionalFileThatUsesStuff.ts",
        })).then(changed => input.flush().then(() => changed))
            .then(report => {
                const after = input.findFileSync("src/AdditionalFileThatUsesStuff.ts").getContentSync();
                assert(after.includes(
                    `andEvenMoreStuff(context: HandlerContext, `), after);
            }).then(() => done(), done);
    });

    it("Adds an import file too", done => {
        const input = copyOfBefore();
        implement(input, addParameterRequirement({
            name: "andEvenMoreStuff", filePath: "src/AdditionalFileThatUsesStuff.ts",
        })).then(changed => input.flush().then(() => changed))
            .then(report => {
                const after = input.findFileSync("src/AdditionalFileThatUsesStuff.ts").getContentSync();
                assert(after.includes(
                    `import { HandlerContext } from "@atomist/automation-client"`), after);
            }).then(() => done(), done);
    });

});

function printMatch(m: TreeNode): string[] {
    let me = m.$name + "/";
    if (!m.$children) {
        me = m.$name + " = " + m.$value;
    }
    const myBabies = _.flatMap(m.$children, ch => printMatch(ch).map(o => " " + o));
    return [me].concat(myBabies);
}

// wishlist: a replacer that would let me print MatchResults, without printing sourceFile every time

describe.skip("actually run it", () => {

    it("will add this parameter in this other project", done => {
        (logger as any).level = "info";

        const realProject = GitCommandGitProject.fromProject(new NodeFsLocalProject("tslint",
            "/Users/jessitron/code/atomist/automation-client-samples-ts-docker"), { token: "poo" });

        function commitDangit(r1: Changeset, report: Report) {
            if (report.implemented.length === 0) {
                logger.info("Skipping commit for " + stringify(r1));
                return Promise.resolve();
            }
            return realProject.commit(describeChangeset(r1)).then(() => Promise.resolve());
        }

        functionCallIdentifierFromProject(realProject, "src/handlers/PushToTsLinting.ts",
            topLevelFunction("problemToAttachment")).then(functionOfInterest => {

            const originalRequirement = new AddParameterRequirement({
                functionWithAdditionalParameter: functionOfInterest,
                parameterName: "token",
                parameterType: { kind: "built-in", name: "string" },
                why: "so I can get file contents from github",
            });

            return applyRequirement(originalRequirement, commitDangit)(realProject)
                .then(report => {
                    logger.info("implemented: " + stringify(report.implemented, null, 1));
                    logger.info("UNimplementED: " + stringify(report.unimplemented, null, 2));
                });
        })
            .then(() => done(), done);
    }).timeout(1000000);
});
