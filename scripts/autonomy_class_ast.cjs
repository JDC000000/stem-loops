#!/usr/bin/env node
// autonomy_class_ast.cjs — the TS/TSX parser half of scripts/autonomy_class.py
// (§11 R1, NARROWED class: Jon 2026-11-23, LEDGER-19A row 49). Called by the
// Python checker; never run on its own in CI.
//
// stdin : {"typescript": "<path to typescript/lib/typescript.js>",
//          "files": [{"id": "...", "name": "x.tsx", "text": "..."}]}
// stdout: {"<id>": {"error": null | "...", "shape": [...], "lits": [...],
//                   "domRead": [names]}}
//
// PARSES ONLY. The PR's bytes are handed to ts.createSourceFile as a string;
// nothing is type-checked, transpiled, resolved, required or evaluated.
//
// shape : every AST node kind and every token of the file in source order
//         (getChildren(), so punctuation, keywords, modifiers and operators
//         are all there), plus every comment in front of each token, VERBATIM.
//         Identifiers, numbers and regexes keep their text. String literals,
//         template pieces and JSX text become a "LIT:<kind>" placeholder: the
//         only things that may differ between base and head.
// lits  : one entry per placeholder, in the same order:
//           raw  the literal's SOURCE text (never the cooked value: review R3
//                B3, String.raw`\d` and String.raw`d` must differ)
//           pos, end  its span in the file
//           ctx  "text" only for JSX text that passes EVERY rule below;
//                otherwise "no:<why>". Every string literal and template
//                piece is "no:" — a changed one is always `human`.
// domRead: identifiers in the file that read rendered text back out of the
//         DOM (textContent, innerText, ...). Such a file can turn a text
//         change into a behaviour change, so the Python side refuses it.
//
// JSX TEXT IS "text" ONLY WHEN (all of):
//   * its DIRECT parent is an intrinsic element whose tag is exactly one of
//     TEXT_PARENTS (lowercase identifier; not a component, not dotted, not
//     namespaced), and that element has no spread attribute and none of
//     FORBIDDEN_ATTR (on*, ref, key, dangerouslySetInnerHTML, is, children);
//   * every enclosing JSX element is intrinsic (lowercase identifier tag), is
//     not in NEVER_UNDER (a, button, label, option, select, textarea, title,
//     script, style, svg, ...) and has no spread / on* / ref /
//     dangerouslySetInnerHTML / is attribute (a handler on an ancestor can
//     read the text back via event.target);
//   * the JSX tree it is in only flows to the RETURN of a React component:
//     walking up through JSX children, (), ?: branches, && / || / ?? right
//     operands and `.map(cb)` callbacks rendered as children, it reaches a
//     `return` or an arrow body of a function declared as a Capitalised
//     function / const, and that name is never used in the file as anything
//     but its declaration, a JSX tag or an export. (Anything else — a const,
//     a call argument, a prop, a custom component's children — can be read
//     as data, review R3 B5.)
"use strict";

const fs = require("fs");

const TEXT_PARENTS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "span", "strong", "em",
]);
const NEVER_UNDER = new Set([
  "a", "button", "label", "option", "optgroup", "select", "datalist",
  "textarea", "input", "output", "title", "script", "style", "noscript",
  "template", "iframe", "object", "embed", "svg", "math", "foreignObject",
  "head", "html", "meta", "link", "base", "slot", "summary", "dialog",
  "form", "fieldset", "legend", "details", "canvas", "video", "audio",
  "picture", "map", "area", "portal", "xmp", "plaintext",
]);
const DOM_READ = new Set([
  "textContent", "innerText", "outerText", "innerHTML", "outerHTML",
  "nodeValue", "wholeText", "querySelector", "querySelectorAll",
  "getElementById", "getElementsByTagName", "getElementsByClassName",
  "getElementsByName", "createTreeWalker", "createNodeIterator",
  "getSelection", "createRange", "childNodes", "firstChild", "lastChild",
  "MutationObserver", "evaluate", "XPathEvaluator",
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

  // "" if the opening element is a plain lowercase identifier tag, else why not.
  function intrinsicTag(open) {
    const t = open && open.tagName;
    if (!t || t.kind !== SK.Identifier) return [null, "tag is not a plain identifier"];
    const name = t.text;
    if (!/^[a-z][a-z0-9]*$/.test(name)) return [null, `<${name}> is not an intrinsic element`];
    return [name, null];
  }

  function attrProblem(open, forbidKey) {
    for (const a of open.attributes.properties) {
      if (a.kind === SK.JsxSpreadAttribute) return "spread attribute";
      if (a.name.kind !== SK.Identifier) return "namespaced attribute";
      const nm = a.name.text;
      if (/^on/i.test(nm)) return `handler attribute ${nm}`;
      if (nm === "ref" || nm === "dangerouslySetInnerHTML" || nm === "is" ||
          nm === "children" || nm === "contentEditable" ||
          nm === "suppressContentEditableWarning" || nm === "inert" ||
          nm === "popover" || nm === "popovertarget" || nm === "popoverTarget") {
        return `attribute ${nm}`;
      }
      if (forbidKey && nm === "key") return "attribute key";
    }
    return null;
  }

  function fnName(fn) {
    if (fn.kind === SK.FunctionDeclaration) return fn.name ? fn.name.text : null;
    if ((fn.kind === SK.ArrowFunction || fn.kind === SK.FunctionExpression) &&
        fn.parent && fn.parent.kind === SK.VariableDeclaration &&
        fn.parent.initializer === fn && fn.parent.name.kind === SK.Identifier) {
      return fn.parent.name.text;
    }
    return null;
  }

  function textCtx(n, sf, refs) {
    const el = n.parent;
    if (!el || el.kind !== SK.JsxElement) return "no:JSX text not directly inside an element";
    const [tag, why] = intrinsicTag(el.openingElement);
    if (!tag) return "no:" + why;
    if (!TEXT_PARENTS.has(tag)) return `no:text under <${tag}> (only p, h1-h6, li, span, strong, em)`;
    const ap = attrProblem(el.openingElement, true);
    if (ap) return `no:<${tag}> has ${ap}`;
    // climb to the component return
    let cur = el;
    for (;;) {
      const p = cur.parent;
      if (!p) return "no:JSX not returned by a component";
      const k = p.kind;
      if (k === SK.JsxElement) {
        if (cur === p.openingElement || cur === p.closingElement) return "no:JSX in a tag";
        const [t2, w2] = intrinsicTag(p.openingElement);
        if (!t2) return "no:under a component (" + w2 + ")";
        if (NEVER_UNDER.has(t2)) return `no:text inside <${t2}>`;
        const a2 = attrProblem(p.openingElement, false);
        if (a2) return `no:ancestor <${t2}> has ${a2}`;
        cur = p; continue;
      }
      if (k === SK.JsxFragment || k === SK.ParenthesizedExpression) { cur = p; continue; }
      if (k === SK.JsxExpression) {
        if (!p.parent || (p.parent.kind !== SK.JsxElement && p.parent.kind !== SK.JsxFragment)) {
          return "no:JSX passed as an attribute value";
        }
        cur = p; continue;
      }
      if (k === SK.ConditionalExpression && cur !== p.condition) { cur = p; continue; }
      if (k === SK.BinaryExpression && cur === p.right) {
        const op = p.operatorToken.kind;
        if (op === SK.AmpersandAmpersandToken || op === SK.BarBarToken ||
            op === SK.QuestionQuestionToken) { cur = p; continue; }
        return "no:JSX used in an expression";
      }
      let fn = null;
      if (k === SK.ReturnStatement) {
        for (let q = p.parent; q; q = q.parent) {
          if (ts.isFunctionLike(q)) { fn = q; break; }
        }
        if (!fn) return "no:return outside a function";
      } else if (k === SK.ArrowFunction && cur === p.body) {
        fn = p;
      } else {
        return "no:JSX flows into " + SK[k];
      }
      // `.map(cb)` whose result is rendered as children: keep climbing
      const call = fn.parent;
      if ((fn.kind === SK.ArrowFunction || fn.kind === SK.FunctionExpression) &&
          call && call.kind === SK.CallExpression && call.arguments.length === 1 &&
          call.arguments[0] === fn && call.expression.kind === SK.PropertyAccessExpression &&
          call.expression.name.text === "map") {
        cur = call; continue;
      }
      const name = fnName(fn);
      if (!name) return "no:JSX returned by a function that is not a named component";
      if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) return `no:${name} is not a Capitalised component`;
      const bad = (refs.get(name) || []).find((r) => !r.ok);
      if (bad) return `no:component ${name} is used as a value (${bad.why})`;
      return "text";
    }
  }

  // Every identifier reference by name, and whether it is a harmless use of
  // a component name (its declaration, a JSX tag, an export).
  function collectRefs(sf) {
    const refs = new Map();
    const add = (name, ok, why) => {
      if (!refs.has(name)) refs.set(name, []);
      refs.get(name).push({ ok, why });
    };
    const walk = (n) => {
      if (n.kind === SK.Identifier) {
        const p = n.parent;
        let ok = false;
        let why = SK[p ? p.kind : 0];
        if (p && (p.kind === SK.FunctionDeclaration || p.kind === SK.VariableDeclaration) &&
            p.name === n) ok = true;
        else if (p && (p.kind === SK.JsxOpeningElement || p.kind === SK.JsxClosingElement ||
                 p.kind === SK.JsxSelfClosingElement) && p.tagName === n) ok = true;
        else if (p && p.kind === SK.ExportSpecifier) ok = true;
        else if (p && p.kind === SK.ExportAssignment && p.expression === n) ok = true;
        add(n.text, ok, why);
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
    return refs;
  }

  for (const f of input.files) {
    const r = { error: null, shape: [], lits: [], domRead: [] };
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
      const refs = collectRefs(sf);
      const dom = new Set();
      const text = f.text;
      const visit = (n) => {
        if (isJSDoc(n)) return;
        // x["textContent"], x["text" + "Content"], x[f()]: a DOM read the
        // identifier scan cannot see. x[k] / x[o.k] / x[0] are not flagged
        // (too common); a DOM_READ name spelled in ANY string literal is.
        if (n.kind === SK.ElementAccessExpression && n.argumentExpression) {
          let a = n.argumentExpression;
          while (a.kind === SK.ParenthesizedExpression || a.kind === SK.AsExpression ||
                 a.kind === SK.NonNullExpression) a = a.expression;
          if (a.kind === SK.StringLiteral || a.kind === SK.NoSubstitutionTemplateLiteral ||
              a.kind === SK.TemplateExpression || a.kind === SK.BinaryExpression ||
              a.kind === SK.CallExpression || a.kind === SK.ConditionalExpression) {
            dom.add("computed member access with a built key");
          }
        }
        if ((n.kind === SK.StringLiteral || n.kind === SK.NoSubstitutionTemplateLiteral) &&
            [...DOM_READ].some((d) => n.text.includes(d))) {
          dom.add("DOM property name in a string");
        }
        const kids = n.getChildren(sf);
        if (kids.length === 0) {
          if (n.kind !== SK.JsxText) {
            // comments between tokens, verbatim (whitespace between them is
            // not shape; the Python side compares it separately)
            const trivia = text.slice(n.pos, n.getStart(sf, false));
            const cs = trivia.match(/\/\/[^\n\r\u2028\u2029]*|\/\*[\s\S]*?\*\//g) || [];
            for (const c of cs) r.shape.push("C:" + c);
            if (trivia.replace(/\/\/[^\n\r\u2028\u2029]*|\/\*[\s\S]*?\*\//g, "").trim() !== "") {
              r.shape.push("T:" + trivia); // something other than space/comments
            }
          }
          if (isLit(n)) {
            r.shape.push("LIT:" + SK[n.kind]);
            const start = n.kind === SK.JsxText ? n.pos : n.getStart(sf, false);
            r.lits.push({
              raw: text.slice(start, n.end),
              pos: start,
              end: n.end,
              ctx: n.kind === SK.JsxText ? textCtx(n, sf, refs)
                : "no:string literal or template text",
            });
          } else if (n.kind === SK.Identifier || n.kind === SK.PrivateIdentifier) {
            r.shape.push("I:" + n.text);
            if (DOM_READ.has(n.text)) dom.add(n.text);
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
      r.domRead = [...dom].sort();
    } catch (e) {
      r.error = "parser crashed: " + String(e && e.message).slice(0, 120);
    }
  }
  process.stdout.write(JSON.stringify(out));
}

main();
