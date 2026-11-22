import { CompletionContext, acceptCompletion, autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { cursorGroupBackward, cursorGroupForward, deleteGroupBackward, deleteGroupForward, history, indentLess, indentMore, moveLineDown, moveLineUp, redo, selectGroupBackward, selectGroupForward, undo } from "@codemirror/commands";
import { HighlightStyle, bracketMatching, foldGutter, LRLanguage, LanguageSupport, syntaxHighlighting, defaultHighlightStyle, ensureSyntaxTree, foldAll, foldEffect, foldService, unfoldAll, unfoldEffect } from "@codemirror/language";
import { highlightSelectionMatches } from "@codemirror/search";
import { Compartment, EditorState, Line, SelectionRange, Text, Transaction } from "@codemirror/state";
import { hoverTooltip } from "@codemirror/view";
import { EditorView, keymap, drawSelection, highlightActiveLine, rectangularSelection, crosshairCursor, lineNumbers, highlightActiveLineGutter, ViewUpdate } from "@codemirror/view";
import { Tree } from "@lezer/common";
import { styleTags, Tag, tags } from "@lezer/highlight";
import { toggleComments } from "./comment.js";
import { executeIndentations } from "./indent.js";
import { parser } from "./netlogo.js";
import { End, ModuleIdentifier, To } from "./netlogo.terms.js";
class Trie {
    constructor() {
        Object.defineProperty(this, "value", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "type", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "children", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Map()
        });
    }
    append(value, type, offset = 0) {
        if (value[offset]) {
            const child = this.children.get(value[offset]) ?? new Trie();
            child.append(value, type, offset + 1);
            this.children.set(value[offset], child);
        }
        else {
            this.value = value;
            this.type = type;
        }
    }
    appendAll(values, type) {
        values.forEach(value => {
            this.append(value, type);
        });
    }
    match(value, offset = 0) {
        if (value[offset]) {
            return this.children.get(value[offset])?.match(value, offset + 1);
        }
        if (this.value == value) {
            return {
                label: this.value,
                type: this.type
            };
        }
        return undefined;
    }
    matches(value, offset = 0) {
        if (value[offset]) {
            return this.children.get(value[offset])?.matches(value, offset + 1) ?? [];
        }
        const entries = [];
        this.children.forEach((child) => {
            entries.push(...child.matches("", offset + 1));
        });
        if (this.value) {
            entries.push({
                label: this.value,
                type: this.type
            });
        }
        return entries;
    }
}
class Program {
    constructor() {
        Object.defineProperty(this, "decls", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        Object.defineProperty(this, "imports", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Map()
        });
        Object.defineProperty(this, "core", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Trie()
        });
        Object.defineProperty(this, "compiled", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Trie()
        });
    }
    setCore(keywords, constants, commands, reporters) {
        this.decls = keywords.filter(value => !value.match("to|to-report|import|export"));
        this.core = new Trie();
        this.core.appendAll(keywords, "keyword");
        this.core.appendAll(constants, "constant");
        this.core.appendAll(commands, "command");
        this.core.appendAll(reporters, "reporter");
    }
    setCompiled(keywords, globals, variables, commands, reporters, imports) {
        this.compiled = new Trie();
        this.compiled.appendAll(keywords, "keyword");
        this.compiled.appendAll(globals, "global");
        this.compiled.appendAll(variables, "variable");
        this.compiled.appendAll(commands, "command");
        this.compiled.appendAll(reporters, "reporter");
        this.imports = new Map(imports);
    }
    match(value, offset = 0) {
        return this.core.match(value, offset) ?? this.compiled.match(value, offset);
    }
    matches(value, offset = 0) {
        return this.core.matches(value, offset).concat(this.compiled.matches(value, offset));
    }
}
const identRegex = /[\w\-.?=*!<>#+/%$\^'&]+/;
const commandTag = Tag.define("command", tags.name);
const reporterTag = Tag.define("reporter", tags.name);
const variableTag = Tag.define("variable", tags.name);
const moduleTag = Tag.define("module", tags.name);
window.onload = () => {
    window.themeConfig = new Compartment();
    window.selectionConfig = new Compartment();
    window.highlightConfig = new Compartment();
    window.syntaxConfig = new Compartment();
    window.historyConfig = new Compartment();
    window.fontConfig = new Compartment();
    window.editableConfig = new Compartment();
    window.readOnlyConfig = new Compartment();
    window.lineNumbersConfig = new Compartment();
    window.program = new Program();
    window.currentTheme = {
        background: "",
        popupBackground: "",
        gutterBorder: "",
        scrollBarBackground: "",
        scrollBarForeground: "",
        scrollBarForegroundHover: "",
        caret: "",
        lineHighlight: "",
        selection: "",
        selectionError: "",
        default: "",
        comment: "",
        constant: "",
        keyword: "",
        command: "",
        reporter: "",
        variable: ""
    };
    window.view = new EditorView({
        parent: document.body,
        extensions: [
            foldGutter(),
            drawSelection(),
            EditorState.allowMultipleSelections.of(true),
            bracketMatching(),
            rectangularSelection({
                eventFilter: (event) => event.shiftKey && event.altKey
            }),
            crosshairCursor(),
            highlightActiveLine(),
            highlightActiveLineGutter(),
            highlightSelectionMatches({
                wholeWords: true
            }),
            autocompletion({
                icons: false,
                optionClass: (completion) => `cm-completionLabel-${completion.type}`
            }),
            hoverTooltip(window.hoverTooltip, {
                hideOnChange: true
            }),
            new LanguageSupport(LRLanguage.define({
                parser: parser.configure({
                    props: [
                        styleTags({
                            Comment: tags.comment,
                            Import: tags.keyword,
                            Export: tags.keyword,
                            From: tags.keyword,
                            As: tags.keyword,
                            Globals: tags.keyword,
                            Breed: tags.keyword,
                            Own: tags.keyword,
                            Extensions: tags.keyword,
                            Includes: tags.keyword,
                            To: tags.keyword,
                            ToReport: tags.keyword,
                            End: tags.keyword,
                            Identifier: tags.name,
                            ModuleIdentifier: moduleTag,
                            Number: tags.literal,
                            String: tags.literal,
                            Command: commandTag,
                            Reporter: reporterTag,
                            Var: variableTag,
                            AlwaysCommand: commandTag,
                            AlwaysReporter: reporterTag,
                            AlwaysVar: variableTag,
                            Constant: tags.literal
                        })
                    ]
                }),
                languageData: {
                    "wordChars": "_.?=*!<>#+/%$^'&-",
                    "autocomplete": window.autocomplete
                }
            })),
            foldService.of(window.getFold),
            keymap.of([
                { key: "Tab", run: acceptCompletion },
                ...completionKeymap,
                { key: "Mod-z", run: window.nullHandler },
                { key: "Mod-y", run: window.nullHandler },
                { key: "Mod-x", run: window.nullHandler },
                { key: "Mod-v", run: window.nullHandler },
                { key: "Mod-m", run: window.nullHandler },
                { key: "Mod-u", run: window.nullHandler },
                { key: "Mod-Backspace", mac: "Alt-Backspace", run: deleteGroupBackward },
                { key: "Mod-Delete", mac: "Alt-Delete", run: deleteGroupForward },
                { key: "Mod-ArrowLeft", mac: "Alt-ArrowLeft", run: cursorGroupBackward, shift: selectGroupBackward },
                { key: "Mod-ArrowRight", mac: "Alt-ArrowRight", run: cursorGroupForward, shift: selectGroupForward },
                { key: "Alt-ArrowUp", run: moveLineUp },
                { key: "Alt-ArrowDown", run: moveLineDown },
                { key: "ArrowRight", run: window.unfoldCurrent },
                { key: "Tab", run: window.indent, shift: window.unindent },
                { key: "Enter", run: window.handleEnter },
                { key: "Alt-f", run: window.nullHandler },
                { key: "Alt-e", run: window.nullHandler },
                { key: "Alt-t", run: window.nullHandler },
                { key: "Alt-z", run: window.nullHandler },
                { key: "Alt-a", run: window.nullHandler },
                { key: "Alt-h", run: window.nullHandler },
            ]),
            EditorView.clickAddsSelectionRange.of((event) => event.altKey),
            EditorView.domEventHandlers({
                click: (event) => {
                    if (event.ctrlKey && event.button == 0) {
                        window.bridge.jumpToDeclaration();
                    }
                }
            }),
            EditorView.updateListener.of((update) => {
                if (update.docChanged) {
                    const state = update.view.state;
                    const canUndo = undo({ state, dispatch: () => { } });
                    const canRedo = redo({ state, dispatch: () => { } });
                    window.bridge.textUpdated(window.overwriting, canUndo, canRedo);
                    window.setHighlight(true);
                    if (!state.readOnly && window.smartIndent) {
                        update.changes.iterChanges((_, __, ___, ____, text) => {
                            const str = text.toString();
                            if (str.match(/[\[\]\n]/) ||
                                (str.match(/[end]/) && state.doc.lineAt(state.selection.main.head).text.match(/^ *end/i))) {
                                executeIndentations(update.view);
                            }
                        });
                    }
                }
                else if (update.selectionSet) {
                    window.setHighlight(update.state.selection.main.empty);
                }
            }),
            window.themeConfig.of(EditorView.theme({})),
            window.selectionConfig.of(EditorView.theme({})),
            window.highlightConfig.of(EditorView.theme({})),
            window.syntaxConfig.of(syntaxHighlighting(defaultHighlightStyle)),
            window.historyConfig.of(history()),
            window.fontConfig.of(EditorView.theme({})),
            window.editableConfig.of(EditorView.editable.of(true)),
            window.readOnlyConfig.of(EditorState.readOnly.of(false)),
            window.lineNumbersConfig.of([])
        ]
    });
};
window.getText = () => {
    return window.toBase64(window.view.state.doc.toString());
};
window.getSelectionStart = () => {
    return window.view.state.selection.ranges[0]?.from ?? 0;
};
window.getSelectionEnd = () => {
    const ranges = window.view.state.selection.ranges;
    return ranges[ranges.length - 1]?.to ?? 0;
};
window.getSelectedText = () => {
    const state = window.view.state;
    const selection = state.selection.ranges.map(range => state.sliceDoc(range.from, range.to)).join("\n");
    return window.toBase64(selection);
};
window.getCaretPosition = () => {
    return window.view.state.selection.main.head;
};
window.getCaretX = () => {
    return Math.round(window.view.coordsAtPos(window.view.state.selection.main.head)?.left ?? 0);
};
window.getCaretY = () => {
    return Math.round(window.view.coordsAtPos(window.view.state.selection.main.head)?.bottom ?? 0);
};
window.getTokenAtCaret = () => {
    const caret = window.view.state.selection.main.head;
    const line = window.view.state.doc.lineAt(caret);
    const text = line.text;
    const offset = caret - line.from;
    let start = offset;
    while (start > 0 && /\S/.test(text[start - 1] ?? "")) {
        start--;
    }
    let end = offset;
    while (end < text.length && /\S/.test(text[end] ?? "")) {
        end++;
    }
    return text.slice(start, end);
};
window.getLinesForOffsets = (offsets) => {
    const doc = window.view.state.doc;
    return offsets.map(offset => doc.lineAt(offset));
};
window.setText = (text) => {
    const state = window.view.state;
    const transaction = state.update({
        changes: { from: 0, to: state.doc.length, insert: window.fromBase64(text) },
        selection: { anchor: 0, head: 0 },
        scrollIntoView: true
    });
    window.overwriting = true;
    window.view.dispatch([transaction]);
    window.overwriting = false;
    window.resetHistory();
};
window.refreshText = () => {
    window.overwriting = true;
    window.view.dispatch({
        changes: {
            from: 0,
            to: window.view.state.doc.length,
            insert: window.view.state.doc.toString()
        },
        selection: {
            anchor: 0,
            head: 0
        },
        scrollIntoView: true
    });
    window.overwriting = false;
};
window.undo = () => {
    undo(window.view);
    window.setHighlight(window.view.state.selection.main.empty);
};
window.redo = () => {
    redo(window.view);
    window.setHighlight(window.view.state.selection.main.empty);
};
window.resetHistory = () => {
    window.view.dispatch({
        effects: [
            window.historyConfig.reconfigure([])
        ]
    });
    window.view.dispatch({
        effects: [
            window.historyConfig.reconfigure(history())
        ]
    });
};
window.copy = () => {
    const state = window.view.state;
    const selection = state.selection.ranges.map(range => state.sliceDoc(range.from, range.to)).join("\n");
    window.bridge.writeClipboard(selection);
    return true;
};
window.cut = () => {
    if (window.view.state.readOnly) {
        return false;
    }
    window.copy();
    window.view.dispatch(window.view.state.replaceSelection(""));
    return true;
};
window.paste = () => {
    if (window.view.state.readOnly) {
        return false;
    }
    window.view.dispatch(window.view.state.replaceSelection(window.bridge.readClipboard()));
    return true;
};
window.select = (start, end) => {
    const length = window.view.state.doc.length;
    const anchor = Math.min(start, length);
    window.view.dispatch({
        selection: { anchor: anchor, head: Math.min(end, length) },
        effects: EditorView.scrollIntoView(anchor, {
            x: "center",
            y: "center"
        })
    });
};
window.selectAll = () => {
    window.view.dispatch({
        selection: { anchor: 0, head: window.view.state.doc.length }
    });
};
window.replaceSelection = (text) => {
    if (!window.view.state.readOnly) {
        window.view.dispatch(window.view.state.replaceSelection(text));
    }
};
window.shiftLeft = () => {
    indentLess(window.view);
};
window.shiftRight = () => {
    indentMore(window.view);
};
window.indent = (view) => {
    if (view.state.readOnly) {
        return false;
    }
    if (window.smartIndent) {
        executeIndentations(view);
    }
    else {
        indentMore(view);
    }
    return true;
};
window.unindent = (view) => {
    if (view.state.readOnly) {
        return false;
    }
    if (window.smartIndent) {
        executeIndentations(view);
    }
    else {
        indentLess(view);
    }
    return true;
};
window.handleEnter = (view) => {
    if (view.state.readOnly) {
        return false;
    }
    view.dispatch(view.state.replaceSelection("\n"), { scrollIntoView: true });
    return true;
};
window.toggleComments = () => {
    if (window.view.state.readOnly) {
        return false;
    }
    toggleComments(window.view);
    return true;
};
window.isEditable = () => {
    return !window.view.state.readOnly;
};
window.setEditable = (editable) => {
    window.view.dispatch({
        effects: [
            window.editableConfig.reconfigure(EditorView.editable.of(editable)),
            window.readOnlyConfig.reconfigure(EditorState.readOnly.of(!editable))
        ]
    });
};
window.setIndenter = (smart) => {
    window.smartIndent = smart;
};
window.getLineNumbers = () => {
    return window.lineNumbers;
};
window.setLineNumbers = (visible) => {
    window.lineNumbers = visible;
    if (visible) {
        window.view.dispatch({
            effects: [
                window.lineNumbersConfig.reconfigure(lineNumbers())
            ]
        });
    }
    else {
        window.view.dispatch({
            effects: [
                window.lineNumbersConfig.reconfigure([])
            ]
        });
    }
};
window.setCompleteOnType = (enabled) => {
    window.completeOnType = enabled;
};
window.setFont = (family, size) => {
    window.view.dispatch({
        effects: [
            window.fontConfig.reconfigure(EditorView.theme({
                "&, .cm-completionLabel, .cm-content, .cm-gutters": {
                    fontSize: `${size}pt`,
                    fontFamily: `${family}, monospace`
                }
            }))
        ]
    });
};
window.setNormalSelection = () => {
    window.view.dispatch({
        effects: [
            window.selectionConfig.reconfigure(EditorView.theme({
                "&.cm-focused .cm-selectionBackground, & .cm-selectionBackground": {
                    backgroundColor: window.currentTheme.selection + " !important"
                }
            }))
        ]
    });
};
window.setErrorSelection = () => {
    window.view.dispatch({
        effects: [
            window.selectionConfig.reconfigure(EditorView.theme({
                "&.cm-focused .cm-selectionBackground, & .cm-selectionBackground": {
                    backgroundColor: window.currentTheme.selectionError + " !important"
                }
            }))
        ]
    });
};
window.setHighlight = (active) => {
    if (window.highlightActive != active) {
        window.highlightActive = active;
        window.view.dispatch({
            effects: [
                window.highlightConfig.reconfigure(EditorView.theme({
                    ".cm-activeLine": {
                        backgroundColor: active ? window.currentTheme.lineHighlight : "transparent"
                    }
                }))
            ]
        });
    }
};
window.getFold = (state, start, end) => {
    const doc = state.doc;
    const startLine = doc.lineAt(start);
    if (startLine.text.trimStart().toLowerCase().startsWith("to")) {
        let endLine = startLine.number + 1;
        while (endLine <= doc.lines) {
            const line = doc.line(endLine).text.trimStart().toLowerCase();
            if (line.startsWith("end")) {
                break;
            }
            if (line.startsWith("to")) {
                return null;
            }
            endLine++;
        }
        if (endLine > doc.lines) {
            return null;
        }
        const to = doc.line(endLine).to;
        if (end == to) {
            return null;
        }
        return { from: end, to: to };
    }
    return null;
};
window.getFolds = (state) => {
    const doc = state.doc;
    return state.selection.ranges.flatMap((range) => {
        const end = doc.lineAt(range.to).number;
        const folds = [];
        let current = doc.lineAt(range.from).number;
        while (current <= end) {
            const line = doc.line(current);
            const fold = window.getFold(state, line.from, line.to);
            if (fold) {
                folds.push(fold);
                current = doc.lineAt(fold.to).number + 1;
            }
            else {
                current++;
            }
        }
        return folds;
    });
};
window.foldSelected = () => {
    window.getFolds(window.view.state).forEach((fold) => {
        window.view.dispatch({
            effects: foldEffect.of(fold)
        });
    });
};
window.unfoldSelected = () => {
    window.getFolds(window.view.state).forEach((fold) => {
        window.view.dispatch({
            effects: unfoldEffect.of(fold)
        });
    });
};
window.foldAll = () => {
    foldAll(window.view);
};
window.unfoldAll = () => {
    unfoldAll(window.view);
};
window.unfoldCurrent = (view) => {
    const selection = view.state.selection.main;
    if (selection.empty && selection.head == view.state.doc.lineAt(selection.head).to) {
        const fold = window.getFold(view.state, selection.head, selection.head);
        if (fold) {
            window.view.dispatch({
                effects: unfoldEffect.of(fold)
            });
        }
    }
    return false;
};
window.setCoreProgram = (keywords, constants, commands, reporters) => {
    window.program.setCore(keywords, constants, commands, reporters);
};
window.setCompiledProgram = (keywords, globals, variables, commands, reporters, imports) => {
    window.program.setCompiled(keywords, globals, variables, commands, reporters, imports);
};
window.autocomplete = (context) => {
    let scope = 0;
    ensureSyntaxTree(window.view.state, context.pos)?.iterate({
        from: 0,
        to: context.pos,
        enter(node) {
            if (node.type.id == To) {
                scope++;
            }
            else if (node.type.id == End && scope > 0) {
                scope--;
            }
        }
    });
    const match = context.matchBefore(identRegex);
    if (scope == 1 && match?.text == "to") {
        scope = 0;
    }
    const inProc = scope > 0;
    if (context.explicit) {
        return {
            from: match?.from ?? context.pos,
            options: window.program.matches(match?.text.toLowerCase() ?? "").filter((completion) => {
                return (completion.type == "keyword" && completion.label != "end") != inProc;
            })
        };
    }
    const doc = context.state.doc;
    if (match && window.completeOnType && doc.sliceString(match.from - 1, match.from) != '"') {
        const line = doc.sliceString(doc.lineAt(match.from).from, match.from).toLowerCase();
        const procMatch = line.match(`^\\s*(to|to-report)\\s+(${identRegex}\\s*\\[)?`);
        const modMatch = line.match(/^\s*(import|export)\s+\[?/);
        const declMatch = line.match(`^\\s*(${window.program.decls.join("|")})\\s*\\[`);
        const letMatch = line.match(/^\s*let\s+$/);
        const semiMatch = line.match(/^.*;/);
        const quoteMatch = line.match(/^.*"/);
        if (procMatch || modMatch || declMatch || letMatch ||
            (semiMatch && (semiMatch[0].match(/(?<!\\)"/g)?.length ?? 0) % 2 == 0) ||
            (quoteMatch && (quoteMatch[0].match(/(?<!\\)"/g)?.length ?? 0) % 2 != 0)) {
            return null;
        }
        return {
            from: match.from,
            options: window.program.matches(match.text.toLowerCase()).filter((completion) => {
                return (completion.type == "keyword" && completion.label != "end") != inProc;
            })
        };
    }
    return null;
};
window.hoverTooltip = (view, pos, side) => {
    const tree = ensureSyntaxTree(view.state, pos);
    if (!tree) {
        return null;
    }
    const node = tree.resolve(pos, side);
    if (node.type.id != ModuleIdentifier) {
        return null;
    }
    const text = view.state.doc.sliceString(node.from, node.to).toLowerCase();
    const path = window.program.imports.get(text);
    if (!path) {
        return null;
    }
    return {
        pos,
        create() {
            const dom = document.createElement("p");
            dom.innerText = `Module path: ${path}`;
            return {
                dom
            };
        }
    };
};
window.doScroll = (mouseX, mouseY, scrollX, scrollY) => {
    const popup = document.querySelector(".cm-tooltip-autocomplete ul");
    if (popup?.contains(document.elementFromPoint(mouseX, mouseY))) {
        popup.scrollBy(scrollX, scrollY);
    }
    else {
        window.view.scrollDOM.scrollBy(scrollX, scrollY);
    }
};
window.syncTheme = (theme) => {
    document.body.style.background = theme.background;
    const root = document.querySelector(":root");
    root.style.setProperty("--scrollbar-background", theme.scrollBarBackground);
    root.style.setProperty("--scrollbar-foreground", theme.scrollBarForeground);
    root.style.setProperty("--scrollbar-foreground-hover", theme.scrollBarForegroundHover);
    window.currentTheme = theme;
    window.view.dispatch({
        effects: [
            window.themeConfig.reconfigure(EditorView.theme({
                "&": {
                    height: "100%"
                },
                "&.cm-focused": {
                    outline: "none"
                },
                "&.cm-focused .cm-nonmatchingBracket": {
                    backgroundColor: "transparent !important"
                },
                "&, .cm-gutters, .cm-gutter, .cm-gutterElement": {
                    backgroundColor: theme.background,
                    color: theme.default
                },
                ".cm-gutters": {
                    borderRightColor: theme.gutterBorder
                },
                "& .cm-cursor, & .cm-dropCursor": {
                    borderLeftColor: theme.caret
                },
                ".cm-selectionMatch": {
                    backgroundColor: theme.selection + " !important"
                },
                ".cm-tooltip-autocomplete": {
                    backgroundColor: theme.background
                },
                ".cm-tooltip-autocomplete ul li[aria-selected]": {
                    backgroundColor: theme.selection
                },
                ".cm-completionLabel-keyword, .cm-tooltip-autocomplete ul .cm-completionLabel-keyword[aria-selected]": {
                    color: theme.keyword
                },
                ".cm-completionLabel-constant, .cm-tooltip-autocomplete ul .cm-completionLabel-constant[aria-selected]": {
                    color: theme.constant
                },
                ".cm-completionLabel-global, .cm-tooltip-autocomplete ul .cm-completionLabel-global[aria-selected]": {
                    color: theme.variable
                },
                ".cm-completionLabel-variable, .cm-tooltip-autocomplete ul .cm-completionLabel-variable[aria-selected]": {
                    color: theme.variable
                },
                ".cm-completionLabel-reporter, .cm-tooltip-autocomplete ul .cm-completionLabel-reporter[aria-selected]": {
                    color: theme.reporter
                },
                ".cm-completionLabel-command, .cm-tooltip-autocomplete ul .cm-completionLabel-command[aria-selected]": {
                    color: theme.command
                },
                ".cm-tooltip-hover": {
                    backgroundColor: theme.popupBackground,
                    color: theme.default
                },
                ".nl-module:hover": {
                    borderWidth: "1px",
                    borderStyle: "solid",
                    borderColor: "red",
                    transitionDelay: "0.5s"
                }
            })),
            window.highlightConfig.reconfigure(EditorView.theme({
                ".cm-activeLine": {
                    backgroundColor: theme.lineHighlight
                }
            })),
            window.syntaxConfig.reconfigure(syntaxHighlighting(HighlightStyle.define([
                { tag: tags.name, color: theme.default },
                { tag: tags.comment, color: theme.comment },
                { tag: tags.keyword, color: theme.keyword, fontWeight: "bold" },
                { tag: tags.literal, color: theme.constant },
                { tag: commandTag, color: theme.command },
                { tag: reporterTag, color: theme.reporter },
                { tag: variableTag, color: theme.variable },
                { tag: moduleTag, color: theme.default, class: "nl-module" }
            ])))
        ]
    });
    window.setNormalSelection();
};
window.nullHandler = (_) => {
    return true;
};
window.toBase64 = (text) => {
    const bytes = new TextEncoder().encode(text);
    let str = "";
    for (let i = 0; i < bytes.byteLength; i++) {
        str += String.fromCharCode(bytes[i] || 0);
    }
    return btoa(str);
};
window.fromBase64 = (text) => {
    return new TextDecoder().decode(Uint8Array.from(atob(text), c => c.codePointAt(0) ?? 0));
};
//# sourceMappingURL=Main.js.map