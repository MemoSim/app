import { Line, SelectionRange, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Tree } from "@lezer/common";
import { parser } from "./netlogo.js";
import { Breed, CloseBracket, Command, End, Extensions, Globals, Includes, OpenBracket, Own, To, ToReport } from "./netlogo.terms.js";
class TokenizedLine {
    constructor(line, tokens) {
        Object.defineProperty(this, "line", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "tokens", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "leading", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "bracketDelta", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "bracketsClosed", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.line = line;
        this.tokens = tokens.filter((node) => !node.type.isTop && !node.type.isError);
        this.bracketDelta = 0;
        this.bracketsClosed = 0;
        const start = this.line.text.search(/\S/);
        if (start == -1) {
            this.leading = this.line.length;
        }
        else {
            this.leading = start;
        }
        for (const token of this.tokens) {
            switch (token.type.id) {
                case OpenBracket:
                    this.bracketDelta++;
                    break;
                case CloseBracket:
                    this.bracketDelta--;
                    this.bracketsClosed = Math.max(this.bracketsClosed, -this.bracketDelta);
                    break;
            }
        }
    }
}
class IndentUpdate {
    constructor(changes, caretShift) {
        Object.defineProperty(this, "changes", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "caretShift", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.changes = changes;
        this.caretShift = caretShift;
    }
}
function getUpdate(view) {
    const doc = view.state.doc;
    let caretShift = 0;
    const changes = view.state.selection.ranges.flatMap((range) => {
        const startLine = doc.lineAt(range.from);
        const endLine = doc.lineAt(range.to);
        const caretLine = doc.lineAt(range.head);
        const tree = parser.parse(doc.sliceString(0, endLine.to));
        const parsedLines = [];
        let currentLine = doc.lineAt(range.from);
        let currentTokens = [];
        tree.iterate({
            enter: (node) => {
                let line = doc.lineAt(node.from);
                if (line.number == currentLine.number) {
                    currentTokens.push(node.node);
                }
                else {
                    if (currentTokens.length > 0) {
                        parsedLines.push(new TokenizedLine(currentLine, currentTokens));
                    }
                    currentLine = line;
                    currentTokens = [node.node];
                }
                return true;
            }
        });
        if (currentTokens.length > 0) {
            parsedLines.push(new TokenizedLine(currentLine, currentTokens));
        }
        if ((parsedLines[parsedLines.length - 1]?.line.number ?? 0) < endLine.number) {
            parsedLines.push(new TokenizedLine(endLine, []));
        }
        let indentLevels = [];
        const indents = [];
        for (const line of parsedLines) {
            const lastIndent = indentLevels[indentLevels.length - 1] ?? 0;
            switch (line.tokens[0]?.type.id ?? -1) {
                case Globals:
                case Breed:
                case Own:
                case Extensions:
                case Includes:
                case To:
                case ToReport:
                case End:
                    indents.push(0);
                    break;
                case CloseBracket:
                    if (line.bracketDelta == 0) {
                        indents.push(Math.max(lastIndent - 2, 0));
                    }
                    else if (line.bracketDelta < 0) {
                        if (indentLevels.length > line.bracketsClosed) {
                            indents.push(Math.max(indentLevels[indentLevels.length - line.bracketsClosed - 1] ?? 0, 0));
                        }
                        else {
                            indents.push((indentLevels[0] ?? 2) - 2);
                        }
                    }
                    else {
                        indents.push(lastIndent);
                    }
                    break;
                case OpenBracket:
                    if (line.leading > lastIndent) {
                        const command = parsedLines[parsedLines.length - 1]?.tokens[0]?.type.id == Command;
                        const delta = parsedLines[parsedLines.length - 1]?.bracketDelta == 0;
                        if (command && delta) {
                            const newLeading = line.leading + (indents[indents.length - 1] ?? 0);
                            if (newLeading % 2 == 1) {
                                indents.push(newLeading + 1);
                            }
                            else {
                                indents.push(newLeading);
                            }
                        }
                        else {
                            indents.push(lastIndent);
                        }
                    }
                    else {
                        indents.push(lastIndent);
                    }
                    break;
                default:
                    indents.push(lastIndent);
            }
            switch (line.tokens[0]?.type.id) {
                case To:
                case ToReport:
                    indentLevels = [2];
                    break;
                case Globals:
                case Breed:
                case Own:
                case Extensions:
                case Includes:
                case End:
                    if (line.bracketDelta == 0) {
                        indentLevels = [];
                    }
                    else if (line.bracketDelta > 0) {
                        for (let i = 0; i < line.bracketDelta; i++) {
                            indentLevels.push(lastIndent + 2);
                        }
                    }
                    else if (line.bracketDelta < 0) {
                        for (let i = 0; i > line.bracketDelta; i--) {
                            indentLevels.pop();
                        }
                    }
                    break;
                case OpenBracket:
                    if (line.bracketDelta > 0) {
                        let indent = lastIndent;
                        if (line.leading > lastIndent) {
                            const command = parsedLines[parsedLines.length - 1]?.tokens[0]?.type.id == Command;
                            const delta = parsedLines[parsedLines.length - 1]?.bracketDelta == 0;
                            if (command && delta) {
                                const newLeading = line.leading + (indents[indents.length - 1] ?? 0);
                                if (newLeading % 2 == 1) {
                                    indent = newLeading + 1;
                                }
                                else {
                                    indent = newLeading;
                                }
                            }
                        }
                        for (let i = 0; i < line.bracketDelta; i++) {
                            indentLevels.push(indent + 2);
                        }
                    }
                    else if (line.bracketDelta > 0) {
                        for (let i = 0; i < line.bracketDelta; i++) {
                            indentLevels.push(lastIndent + 2);
                        }
                    }
                    else if (line.bracketDelta < 0) {
                        for (let i = 0; i > line.bracketDelta; i--) {
                            indentLevels.pop();
                        }
                    }
                    break;
                default:
                    if (line.bracketDelta > 0) {
                        for (let i = 0; i < line.bracketDelta; i++) {
                            indentLevels.push(lastIndent + 2);
                        }
                    }
                    else if (line.bracketDelta < 0) {
                        for (let i = 0; i > line.bracketDelta; i--) {
                            indentLevels.pop();
                        }
                    }
            }
        }
        const shifts = [];
        for (let i = 0; i < parsedLines.length; i++) {
            if ((parsedLines[i]?.line.number ?? 0) >= startLine.number) {
                const leading = parsedLines[i]?.leading ?? 0;
                const indent = indents[i] ?? 0;
                if (leading != indent) {
                    const start = parsedLines[i]?.line.from ?? 0;
                    shifts.push({
                        from: start,
                        to: start + leading,
                        insert: " ".repeat(indent)
                    });
                    if (parsedLines[i]?.line.number == caretLine.number) {
                        caretShift = indent - leading;
                    }
                }
            }
        }
        return shifts;
    });
    return new IndentUpdate(changes, caretShift);
}
export function executeIndentations(view) {
    const update = getUpdate(view);
    if (update.caretShift == 0) {
        view.dispatch({
            changes: update.changes
        });
    }
    else {
        const newHead = view.state.selection.main.head + update.caretShift;
        view.dispatch({
            changes: update.changes,
            selection: {
                anchor: newHead,
                head: newHead
            }
        });
    }
    window.setHighlight(view.state.selection.main.empty);
}
;
//# sourceMappingURL=indent.js.map