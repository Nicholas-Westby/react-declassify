import type { ArrowFunctionExpression, ClassMethod, ClassPrivateMethod, Expression, FunctionDeclaration, FunctionExpression, Identifier, ImportDeclaration, MemberExpression, ObjectMethod, Pattern, RestElement, Statement, TSEntityName, TSType, TSTypeAnnotation } from "@babel/types";
import type { NodePath, PluginObj, PluginPass } from "@babel/core";
import { assignReturnType, assignTypeAnnotation, assignTypeParameters, importName, isTS, nonNullPath } from "./utils.js";
import { AnalysisError, analyzeBody, analyzeHead, ComponentBody, ComponentHead, needsProps, LibRef } from "./analysis.js";

type Options = {};

export default function plugin(babel: typeof import("@babel/core")): PluginObj<PluginPass & { opts: Options }> {
  const { types: t } = babel;
  return {
    name: "react-declassify",
    visitor: {
      ClassDeclaration(path, state) {
        const ts = isTS(state);
        const head = analyzeHead(path);
        if (!head) {
          return;
        }
        if (path.parentPath.isExportDefaultDeclaration()) {
          const declPath = path.parentPath;
          try {
            const body = analyzeBody(path, head);
            const { funcNode, typeNode } = transformClass(head, body, { ts }, babel);
            if (path.node.id) {
              declPath.replaceWithMultiple([
                t.variableDeclaration("const", [
                  t.variableDeclarator(
                    ts
                    ? assignTypeAnnotation(
                      t.cloneNode(path.node.id),
                      t.tsTypeAnnotation(typeNode!),
                    )
                    : t.cloneNode(path.node.id),
                    funcNode,
                  )
                ]),
                t.exportDefaultDeclaration(
                  t.cloneNode(path.node.id)
                )
              ]);
            } else {
              path.replaceWith(funcNode);
            }
          } catch (e) {
            if (!(e instanceof AnalysisError)) {
              throw e;
            }
            t.addComment(declPath.node, "leading", ` react-declassify-disable Cannot perform transformation: ${e.message} `);
            refreshComments(declPath.node);
          }
        } else {
          try {
            const body = analyzeBody(path, head);
            const { funcNode, typeNode } = transformClass(head, body, { ts }, babel);
            path.replaceWith(t.variableDeclaration("const", [
              t.variableDeclarator(
                ts
                ? assignTypeAnnotation(
                  t.cloneNode(path.node.id),
                  t.tsTypeAnnotation(typeNode!),
                )
                : t.cloneNode(path.node.id),
                funcNode,
              )
            ]));
          } catch (e) {
            if (!(e instanceof AnalysisError)) {
              throw e;
            }
            t.addComment(path.node, "leading", ` react-declassify-disable Cannot perform transformation: ${e.message} `);
            refreshComments(path.node);
          }
        }
      },
    },
  };
}

type TransformResult = {
  funcNode: ArrowFunctionExpression;
  typeNode?: TSType | undefined;
};

function transformClass(head: ComponentHead, body: ComponentBody, options: { ts: boolean }, babel: typeof import("@babel/core")): TransformResult {
  const { types: t } = babel;
  const { ts } = options;

  for (const [, prop] of body.props.props) {
    for (const alias of prop.aliases) {
      if (alias.localName !== prop.newAliasName!) {
        // Rename variables that props are bound to.
        // E.g. `foo` as in `const { foo } = this.props`.
        // This is to ensure we hoist them correctly.
        alias.scope.rename(alias.localName, prop.newAliasName!);
      }
    }
  }
  for (const path of body.locals.removePaths) {
    path.remove();
  }
  for (const ren of body.render.renames) {
    // Rename local variables in the render method
    // to avoid unintentional variable capturing.
    ren.scope.rename(ren.oldName, ren.newName);
  }
  if (body.props.hasDefaults) {
    for (const [, prop] of body.props.props) {
      for (const site of prop.sites) {
        // this.props.foo -> foo
        site.path.replaceWith(t.identifier(prop.newAliasName!));
      }
    }
  } else {
    for (const site of body.props.sites) {
      // this.props -> props
      site.path.replaceWith(site.path.node.property);
    }
  }
  for (const [, prop] of body.props.props) {
    if (prop.defaultValue && prop.typing) {
      // Make the prop optional
      prop.typing.node.optional = true;
      if (prop.typing.isTSPropertySignature()) {
        const typeAnnotation = nonNullPath(prop.typing.get("typeAnnotation"))?.get("typeAnnotation");
        if (typeAnnotation) {
          if (typeAnnotation.isTSUnionType()) {
            if (typeAnnotation.node.types.some((t) => t.type === "TSUndefinedKeyword")) {
              // No need to add undefined
            } else {
              typeAnnotation.node.types.push(t.tsUndefinedKeyword());
            }
          } else {
            typeAnnotation.replaceWith(t.tsUnionType([
              typeAnnotation.node,
              t.tsUndefinedKeyword(),
            ]))
          }
        }
      }
      if (
        prop.typing.node.type === "TSPropertySignature"
        && prop.typing.node.typeAnnotation
      ) {
        const typeAnnot = prop.typing.node.typeAnnotation
      }
    }
  }
  for (const [name, stateAnalysis] of body.state) {
    for (const site of stateAnalysis.sites) {
      if (site.type === "expr") {
        // this.state.foo -> foo
        site.path.replaceWith(t.identifier(stateAnalysis.localName!));
      } else if (site.type === "setState") {
        // this.setState({ foo: 1 }) -> setFoo(1)
        site.path.replaceWith(
          t.callExpression(
            t.identifier(stateAnalysis.localSetterName!),
            [site.valuePath.node]
          )
        );
      }
    }
  }
  for (const [, field] of body.userDefined.fields) {
    if (field.type === "user_defined_function" || field.type === "user_defined_ref") {
      for (const site of field.sites) {
        if (site.type === "expr") {
          // this.foo -> foo
          site.path.replaceWith(t.identifier(field.localName!));
        }
      }
    } else if (field.type === "user_defined_direct_ref") {
      for (const site of field.sites) {
        if (site.type === "expr") {
          // this.foo -> foo.current
          site.path.replaceWith(
            t.memberExpression(
              t.identifier(field.localName!),
              t.identifier("current")
            )
          );
        }
      }
    }
  }
  // Preamble is a set of statements to be added before the original render body.
  const preamble: Statement[] = [];
  const propsWithAlias = Array.from(body.props.props).filter(([, prop]) => prop.needsAlias);
  if (propsWithAlias.length > 0) {
    // Expand this.props into variables.
    // E.g. const { foo, bar } = props;
    preamble.push(t.variableDeclaration("const", [
      t.variableDeclarator(
        t.objectPattern(propsWithAlias.map(([name, prop]) =>
          t.objectProperty(
            t.identifier(name),
            prop.defaultValue
            ? t.assignmentPattern(
              t.identifier(prop.newAliasName!),
              prop.defaultValue.node
            )
            : t.identifier(prop.newAliasName!),
            false,
            name === prop.newAliasName!,
          ),
        )),
        t.identifier("props"),
      ),
    ]));
  }
  for (const field of body.state.values()) {
    // State declarations
    const call = t.callExpression(
      getReactImport("useState", babel, head.superClassRef),
      field.init ? [field.init.valuePath.node] : []
    );
    preamble.push(t.variableDeclaration("const", [
      t.variableDeclarator(
        t.arrayPattern([
          t.identifier(field.localName!),
          t.identifier(field.localSetterName!),
        ]),
        ts && field.typeAnnotation ?
          assignTypeParameters(
            call,
            t.tsTypeParameterInstantiation([
              field.typeAnnotation.type === "method"
              ? t.tsFunctionType(
                  undefined,
                  field.typeAnnotation.params.map((p) => p.node),
                  t.tsTypeAnnotation(field.typeAnnotation.returnType.node)
                )
              : field.typeAnnotation.path.node
            ])
          )
        : call
      )
    ]))
  }
  for (const [, field] of body.userDefined.fields) {
    if (field.type === "user_defined_function") {
      // Method definitions.
      if (field.init.type === "method") {
        const methNode = field.init.path.node;
        preamble.push(functionDeclarationFrom(babel, methNode, t.identifier(field.localName!)));
      } else {
        const methNode = field.init.initPath.node;
        if (
          methNode.type === "FunctionExpression"
          && !field.typeAnnotation
        ) {
          preamble.push(functionDeclarationFrom(babel, methNode, t.identifier(field.localName!)));
        } else {
          const expr =
            methNode.type === "FunctionExpression"
            ? functionExpressionFrom(babel, methNode)
            : arrowFunctionExpressionFrom(babel, methNode);
          preamble.push(t.variableDeclaration(
            "const",
            [t.variableDeclarator(
              assignTypeAnnotation(
                t.identifier(field.localName!),
                field.typeAnnotation ? t.tsTypeAnnotation(field.typeAnnotation.node) : undefined
              ),
              expr
            )]
          ));
        }
      }
    } else if (field.type === "user_defined_ref") {
      // const foo = useRef(null);
      const call = t.callExpression(
        getReactImport("useRef", babel, head.superClassRef),
        [t.nullLiteral()]
      );
      preamble.push(t.variableDeclaration(
        "const",
        [t.variableDeclarator(
          t.identifier(field.localName!),
          ts && field.typeAnnotation
            ? assignTypeParameters(
              call,
              t.tsTypeParameterInstantiation([
                field.typeAnnotation.node
              ])
            )
            : call
        )]
      ))
    } else if (field.type === "user_defined_direct_ref") {
      // const foo = useRef(init);
      const call = t.callExpression(
        getReactImport("useRef", babel, head.superClassRef),
        [field.init.node]
      );
      preamble.push(t.variableDeclaration(
        "const",
        [t.variableDeclarator(
          t.identifier(field.localName!),
          ts && field.typeAnnotation
            ? assignTypeParameters(
              call,
              t.tsTypeParameterInstantiation([
                field.typeAnnotation.node
              ])
            )
            : call
        )]
      ))
    }
  }
  const bodyNode = body.render.path.node.body;
  bodyNode.body.splice(0, 0, ...preamble);
  return {
    funcNode: t.arrowFunctionExpression(
      needsProps(body) ? [t.identifier("props")] : [],
      bodyNode
    ),
    typeNode: ts
      ? t.tsTypeReference(
        toTSEntity(getReactImport("FC", babel, head.superClassRef), babel),
        head.props
        ? t.tsTypeParameterInstantiation([head.props.node])
        : null
      )
      : undefined,
  };
}

function toTSEntity(
  expr: Expression,
  babel: typeof import("@babel/core"),
): TSEntityName {
  const { types: t } = babel;
  if (expr.type === "MemberExpression" && !expr.computed && expr.property.type === "Identifier") {
    return t.tsQualifiedName(toTSEntity(expr.object, babel), t.cloneNode(expr.property));
  } else if (expr.type === "Identifier") {
    return t.cloneNode(expr);
  }
  throw new Error(`Cannot convert to TSEntityName: ${expr.type}`);
}

function getReactImport(
  name: string,
  babel: typeof import("@babel/core"),
  superClassRef: LibRef
): MemberExpression | Identifier {
  const { types: t } = babel;
  if (superClassRef.type === "global") {
    return t.memberExpression(
      t.identifier(superClassRef.globalName),
      t.identifier(name),
    );
  }
  if (superClassRef.kind === "ns") {
    return t.memberExpression(
      t.identifier(superClassRef.specPath.node.local.name),
      t.identifier(name),
    );
  }
  const decl = superClassRef.specPath.parentPath as NodePath<ImportDeclaration>;
  for (const spec of decl.get("specifiers")) {
    if (spec.isImportSpecifier() && importName(spec.node.imported) === name) {
      return t.cloneNode(spec.node.local);
    }
  }
  // No existing decl
  const newName = decl.scope.getBinding(name) ? decl.scope.generateUid(name) : name;
  const local = t.identifier(newName);
  decl.get("specifiers")[decl.node.specifiers.length - 1]!.insertAfter(
    t.importSpecifier(
      local,
      name === newName ? local : t.identifier(newName)
    )
  );
  return t.identifier(newName);
}

type FunctionLike = FunctionDeclaration | FunctionExpression | ArrowFunctionExpression | ClassMethod | ClassPrivateMethod | ObjectMethod;

function functionName(node: FunctionLike): Identifier | undefined {
  switch (node.type) {
    case "FunctionDeclaration":
    case "FunctionExpression":
      return node.id ?? undefined;
  }
}

function functionDeclarationFrom(
  babel: typeof import("@babel/core"),
  node: FunctionLike,
  name?: Identifier | null
) {
  const { types: t } = babel;
  return assignReturnType(
    t.functionDeclaration(
      name ?? functionName(node),
      node.params as (Identifier | RestElement | Pattern)[],
      node.body.type === "BlockStatement"
      ? node.body
      : t.blockStatement([
          t.returnStatement(node.body)
        ]),
      node.generator,
      node.async,
    ),
    node.returnType
  );
}

function functionExpressionFrom(
  babel: typeof import("@babel/core"),
  node: FunctionLike,
  name?: Identifier | null
) {
  const { types: t } = babel;
  return assignReturnType(
    t.functionExpression(
      name ?? functionName(node),
      node.params as (Identifier | RestElement | Pattern)[],
      node.body.type === "BlockStatement"
      ? node.body
      : t.blockStatement([
          t.returnStatement(node.body)
        ]),
      node.generator,
      node.async,
    ),
    node.returnType
  );
}

function arrowFunctionExpressionFrom(
  babel: typeof import("@babel/core"),
  node: FunctionLike
) {
  const { types: t } = babel;
  return assignReturnType(
    t.arrowFunctionExpression(
      node.params as (Identifier | RestElement | Pattern)[],
      node.body,
      node.async,
    ),
    node.returnType
  );
}

/**
 * Refreshes recast's internal state to force generically printing comments.
 */
function refreshComments(node: any) {
  for (const comment of node.leadingComments ?? []) {
    comment.leading ??= true;
    comment.trailing ??= false;
  }
  for (const comment of node.trailingComments ?? []) {
    comment.leading ??= false;
    comment.trailing ??= true;
  }
  node.comments = [
    ...node.leadingComments ?? [],
    ...node.innerComments ?? [],
    ...node.trailingComments ?? [],
  ];
  node.original = undefined;
}
