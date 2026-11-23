#!/usr/bin/env node
// autonomy_class_ast.cjs — the TS/TSX parser half of scripts/autonomy_class.py
// (§11 R1, content-only design). Called by the Python checker; never run on
// its own in CI.
//
// stdin : {"typescript": "<path to typescript/lib/typescript.js>",
//          "files": [{"id": "...", "name": "x.tsx", "text": "..."}]}
// stdout: {"<id>": {"error": null | "...", "shape": [...], "lits": [...],
//                   "dynamic": bool}}
//
// PARSES ONLY. The PR's bytes are handed to ts.createSourceFile as a string;
// nothing is type-checked, transpiled, resolved, required or evaluated.
//
// shape : every token of the file in source order (getChildren(), so
//         punctuation, keywords, modifiers and operators are all there),
//         plus the comments in front of each token (whitespace removed).
//         Identifiers, numbers, regexes and comments keep their text.
//         String literals, template pieces and JSX text become a "LIT"
//         placeholder: the ONLY things that may differ between base and head.
// lits  : one entry per placeholder, in the same order: {v, ctx}.
//         v   = the literal's value (cooked; raw for an invalid template)
//         ctx = where it sits, decided here from the parent chain:
//           "text"        JSX text, not inside a raw-text element
//           "attr:<name>" the whole value of JSX attribute <name>
//           "child"       a JSX child {"..."} (through ?:, +, &&, ||, ??, ())
//           "value:<key>" a const / property value / array item / return
//           "no:<why>"    anywhere else (call argument, member key, import,
//                         directive, type, comparison, tagged template, ...)
// dynamic: the file has computed member access (x[k], k not a number
//         literal), a computed property name or a JSX spread attribute.
"use strict";

const fs = require("fs");

const RAW_TAGS = new Set([
  "script", "style", "iframe", "noscript", "template", "object", "embed",
  "textarea", "title", "xmp", "plaintext", "math", "svg", "foreignobject",
  "head", "html", "markdown", "rawhtml", "innerhtml", "trans",
]);

function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  const ts = require(input.typescript);
  const SK = ts.SyntaxKind;
  const out = {};

  const isJSDoc = (n) => n.kind >= SK.FirstJSDocNode && n.kind <= SK.LastJSDocNode;
  const isLit = (n) =>
    n.kind === SK.StringLiteral ||
    n.kind === SK.NoSubstitutionTemplateLiteral ||
    n.kind === SK.TemplateHead ||
    n.kind === SK.TemplateMiddle ||
    n.kind === SK.TemplateTail ||
    n.kind === SK.JsxText;

  function tagName(el) {
    const open = el.kind === SK.JsxElement ? el.openingElement : el;
    if (!open || !open.tagName) return "";
    // `<Script>`, `<x.Style>`: the last segment, case-folded
    const t = open.tagName.getText().split(".").pop();
    return t.toLowerCase();
  }

  function inRawTag(n) {
    for (let p = n.parent; p; p = p.parent) {
      if (p.kind === SK.JsxElement || p.kind === SK.JsxSelfClosingElement) {
        if (RAW_TAGS.has(tagName(p))) return true;
      }
    }
    return false;
  }

  function keyName(name) {
    if (!name) return null;
    if (name.kind === SK.Identifier) return name.text;
    return null; // string / numeric / computed / private keys: not a plain name
  }

  // Walk up through value-preserving wrappers; return the first other node
  // and the child we came from.
  function climb(n) {
    let c = n;
    let p = n.parent;
    for (;;) {
      if (!p) return [c, p];
      const k = p.kind;
      if (k === SK.ParenthesizedExpression || k === SK.TemplateSpan ||
          k === SK.TemplateExpression) {
        // a TemplateExpression is only a wrapper if it is not tagged
        if (k === SK.TemplateExpression && p.parent &&
            p.parent.kind === SK.TaggedTemplateExpression) return [p, p.parent];
        c = p; p = p.parent; continue;
      }
      if (k === SK.ConditionalExpression && c !== p.condition) {
        c = p; p = p.parent; continue;
      }
      if (k === SK.BinaryExpression) {
        const op = p.operatorToken.kind;
        if (op === SK.PlusToken || op === SK.AmpersandAmpersandToken ||
            op === SK.BarBarToken || op === SK.QuestionQuestionToken) {
          c = p; p = p.parent; continue;
        }
      }
      return [c, p];
    }
  }

  function context(n) {
    if (n.kind === SK.JsxText) return inRawTag(n) ? "no:raw-text element" : "text";
    // anything inside a type is never content
    for (let p = n.parent; p; p = p.parent) {
      if (ts.isTypeNode(p) && p.kind !== SK.ExpressionWithTypeArguments) {
        return "no:type position";
      }
      if (p.kind === SK.ImportDeclaration || p.kind === SK.ExportDeclaration ||
          p.kind === SK.ImportEqualsDeclaration || p.kind === SK.ExternalModuleReference) {
        return "no:import/export";
      }
      if (p.kind === SK.ElementAccessExpression) return "no:member key";
      if (p.kind === SK.ComputedPropertyName) return "no:computed key";
      if (p.kind === SK.TaggedTemplateExpression) return "no:tagged template";
      if (p.kind === SK.Decorator) return "no:decorator";
      if (p.kind === SK.CallExpression || p.kind === SK.NewExpression) {
        // a literal inside a function passed to a call is judged inside
        // that function; stop at function boundaries only for this rule
        return "no:call argument";
      }
      if (ts.isFunctionLike(p)) break;
    }
    const [c, p] = climb(n);
    if (!p) return "no:top level";
    switch (p.kind) {
      case SK.JsxAttribute: {
        if (inRawTag(p)) return "no:raw-text element";
        const nm = p.name.kind === SK.Identifier ? p.name.text : "ns:" + p.name.getText();
        return "attr:" + nm;
      }
      case SK.JsxExpression: {
        const pp = p.parent;
        if (pp && pp.kind === SK.JsxAttribute) {
          if (inRawTag(pp)) return "no:raw-text element";
          const nm = pp.name.kind === SK.Identifier ? pp.name.text : "ns:" + pp.name.getText();
          return "attr:" + nm;
        }
        if (pp && (pp.kind === SK.JsxElement || pp.kind === SK.JsxFragment)) {
          return inRawTag(p) ? "no:raw-text element" : "child";
        }
        return "no:jsx expression";
      }
      case SK.VariableDeclaration:
        if (c === p.initializer && p.name.kind === SK.Identifier) return "value:" + p.name.text;
        return "no:binding";
      case SK.PropertyAssignment: {
        if (c !== p.initializer) return "no:property key";
        const k = keyName(p.name);
        return k === null ? "no:non-identifier key" : "value:" + k;
      }
      case SK.ArrayLiteralExpression:
        return "value:[]";
      case SK.ReturnStatement:
        return "value:return";
      case SK.ArrowFunction:
        return c === p.body ? "value:return" : "no:arrow";
      default:
        return "no:" + SK[p.kind];
    }
  }

  for (const f of input.files) {
    const r = { error: null, shape: [], lits: [], dynamic: false };
    out[f.id] = r;
    try {
      const kind = f.name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      const sf = ts.createSourceFile(f.name, f.text, ts.ScriptTarget.Latest, true, kind);
      const diags = sf.parseDiagnostics || [];
      if (diags.length) {
        r.error = "parse error: " +
          ts.flattenDiagnosticMessageText(diags[0].messageText, " ").slice(0, 120);
        continue;
      }
      const text = f.text;
      const visit = (n) => {
        if (isJSDoc(n)) return;
        if (n.kind === SK.ElementAccessExpression &&
            !(n.argumentExpression && n.argumentExpression.kind === SK.NumericLiteral)) {
          r.dynamic = true;
        }
        if (n.kind === SK.ComputedPropertyName || n.kind === SK.JsxSpreadAttribute) {
          r.dynamic = true;
        }
        const kids = n.getChildren(sf);
        if (kids.length === 0) {
          const trivia = text.slice(n.pos, n.getStart(sf, false)).replace(/\s+/g, "");
          if (n.kind === SK.JsxText) {
            // JSX text owns its whitespace; there is no trivia to compare
          } else if (trivia) {
            r.shape.push("C:" + trivia);
          }
          if (isLit(n)) {
            r.shape.push("LIT:" + SK[n.kind]);
            const v = n.kind === SK.JsxText ? n.text
              : (n.text !== undefined ? n.text : n.rawText);
            r.lits.push({ v: String(v), ctx: context(n) });
          } else if (n.kind === SK.Identifier || n.kind === SK.PrivateIdentifier) {
            r.shape.push("I:" + n.text);
          } else if (n.kind === SK.NumericLiteral || n.kind === SK.BigIntLiteral ||
                     n.kind === SK.RegularExpressionLiteral) {
            r.shape.push(SK[n.kind] + ":" + n.getText(sf));
          } else {
            r.shape.push(SK[n.kind] + (n.kind === SK.EndOfFileToken ? "" : ":" + n.getText(sf)));
          }
          return;
        }
        r.shape.push("(" + SK[n.kind]);
        for (const k of kids) visit(k);
        r.shape.push(")");
      };
      visit(sf);
    } catch (e) {
      r.error = "parser crashed: " + String(e && e.message).slice(0, 120);
    }
  }
  process.stdout.write(JSON.stringify(out));
}

main();
