import { EditorView } from "@codemirror/view";
import { Line, SelectionRange, Text } from "@codemirror/state";
export function toggleComments(view) {
    const doc = view.state.doc;
    const lines = view.state.selection.ranges.flatMap((range) => {
        const startLine = doc.lineAt(range.from).number;
        const endLine = doc.lineAt(range.to).number;
        const lines = [];
        for (let i = startLine; i <= endLine; i++) {
            lines.push(i);
        }
        return lines;
    });
    const nonEmptyLines = [];
    for (const i of lines) {
        const line = doc.line(i).text;
        if (line.trim().length > 0) {
            nonEmptyLines.push(line);
        }
    }
    if (nonEmptyLines.length == 0) {
        view.dispatch({
            changes: lines.map((i) => {
                const offset = doc.line(i).from;
                return {
                    from: offset,
                    to: offset,
                    insert: "; "
                };
            })
        });
    }
    else if (nonEmptyLines.every((line) => line.trimStart().startsWith(";"))) {
        view.dispatch({
            changes: lines.map((i) => {
                const line = doc.line(i);
                const text = line.text;
                const index = text.indexOf(";");
                if (index == -1) {
                    return [];
                }
                const offset = line.from + index;
                if (text.length > index + 1 && /\s/.test(text[index + 1] ?? "")) {
                    return {
                        from: offset,
                        to: offset + 2,
                        insert: ""
                    };
                }
                return {
                    from: offset,
                    to: offset + 1,
                    insert: ""
                };
            })
        });
    }
    else {
        const offset = Math.min(...nonEmptyLines.map((line) => line.search(/\S/)));
        view.dispatch({
            changes: lines.map((i) => {
                const line = doc.line(i);
                if (line.text.trim().length == 0) {
                    return [];
                }
                const start = line.from + offset;
                return {
                    from: start,
                    to: start,
                    insert: "; "
                };
            })
        });
    }
}
//# sourceMappingURL=comment.js.map