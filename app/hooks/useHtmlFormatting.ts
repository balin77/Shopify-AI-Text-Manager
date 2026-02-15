import { useCallback, useRef } from "react";
import { useI18n } from "../contexts/I18nContext";

export type HtmlFormattingCommand =
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "h1"
  | "h2"
  | "h3"
  | "p"
  | "ul"
  | "ol"
  | "br"
  | "blockquote"
  | "code"
  | "link"
  | "unlink"
  | "undo"
  | "redo"
  | "removeFormat";

interface UseHtmlFormattingProps {
  editorRef: React.RefObject<HTMLDivElement | null>;
  onChange: (html: string) => void;
}

const INLINE_TAG_MAP: Partial<Record<HtmlFormattingCommand, string>> = {
  bold: "STRONG",
  italic: "EM",
  underline: "U",
  strikethrough: "S",
};

const BLOCK_TAG_MAP: Partial<Record<HtmlFormattingCommand, string>> = {
  h1: "H1",
  h2: "H2",
  h3: "H3",
  p: "P",
  blockquote: "BLOCKQUOTE",
  code: "PRE",
};

const BLOCK_TAGS = new Set([
  "P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6",
  "BLOCKQUOTE", "PRE", "UL", "OL", "LI",
]);

const MAX_HISTORY = 50;

function getSelectionInEditor(editor: HTMLElement): Range | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return null;
  return range;
}

function findAncestor(node: Node, tagName: string, boundary: HTMLElement): HTMLElement | null {
  let current: Node | null = node;
  while (current && current !== boundary) {
    if (current instanceof HTMLElement && current.tagName === tagName) {
      return current;
    }
    current = current.parentNode;
  }
  return null;
}

function findClosestBlock(node: Node, boundary: HTMLElement): HTMLElement {
  let current: Node | null = node;
  while (current && current !== boundary) {
    if (current instanceof HTMLElement && BLOCK_TAGS.has(current.tagName)) {
      return current;
    }
    current = current.parentNode;
  }
  return boundary;
}

function unwrapElement(el: HTMLElement): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) {
    parent.insertBefore(el.firstChild, el);
  }
  parent.removeChild(el);
}

function toggleInlineTag(range: Range, tagName: string, editor: HTMLElement): void {
  const existing = findAncestor(range.commonAncestorContainer, tagName, editor);
  if (existing) {
    // Remember children so we can restore selection after unwrap
    const firstChild = existing.firstChild;
    const lastChild = existing.lastChild;
    unwrapElement(existing);
    // Restore selection over the unwrapped content
    if (firstChild && lastChild) {
      const sel = window.getSelection();
      if (sel) {
        const newRange = document.createRange();
        newRange.setStartBefore(firstChild);
        newRange.setEndAfter(lastChild);
        sel.removeAllRanges();
        sel.addRange(newRange);
      }
    }
    return;
  }

  const contents = range.extractContents();
  const wrapper = document.createElement(tagName);
  wrapper.appendChild(contents);
  range.insertNode(wrapper);

  // Restore selection around the wrapped content
  const sel = window.getSelection();
  if (sel) {
    const newRange = document.createRange();
    newRange.selectNodeContents(wrapper);
    sel.removeAllRanges();
    sel.addRange(newRange);
  }
}

function setBlockType(range: Range, tagName: string, editor: HTMLElement): void {
  const block = findClosestBlock(range.startContainer, editor);
  if (block === editor) {
    // No block parent — find the inline content group around the cursor and wrap it
    let targetNode: Node | null = range.startContainer;
    while (targetNode && targetNode.parentNode !== editor) {
      targetNode = targetNode.parentNode;
    }
    if (!targetNode) return;

    // Collect consecutive non-block siblings around the cursor
    let start: Node = targetNode;
    let end: Node = targetNode;
    while (start.previousSibling && !(start.previousSibling instanceof HTMLElement && BLOCK_TAGS.has(start.previousSibling.tagName))) {
      start = start.previousSibling;
    }
    while (end.nextSibling && !(end.nextSibling instanceof HTMLElement && BLOCK_TAGS.has(end.nextSibling.tagName))) {
      end = end.nextSibling;
    }

    const wrapper = document.createElement(tagName);
    editor.insertBefore(wrapper, start);
    let current: Node | null = start;
    while (current) {
      const next: Node | null = current.nextSibling;
      wrapper.appendChild(current);
      if (current === end) break;
      current = next;
    }

    const sel = window.getSelection();
    if (sel) {
      const newRange = document.createRange();
      newRange.selectNodeContents(wrapper);
      newRange.collapse(false);
      sel.removeAllRanges();
      sel.addRange(newRange);
    }
    return;
  }

  // Toggle: if already the target type, revert to <p>
  const targetTag = block.tagName === tagName ? "P" : tagName;

  const replacement = document.createElement(targetTag);
  while (block.firstChild) {
    replacement.appendChild(block.firstChild);
  }
  block.parentNode!.replaceChild(replacement, block);

  // Place cursor inside the new block
  const sel = window.getSelection();
  if (sel) {
    const newRange = document.createRange();
    newRange.selectNodeContents(replacement);
    newRange.collapse(false);
    sel.removeAllRanges();
    sel.addRange(newRange);
  }
}

function toggleList(range: Range, listTag: string, editor: HTMLElement): void {
  const existingList = findAncestor(range.commonAncestorContainer, listTag, editor);
  if (existingList) {
    // Unwrap: convert each <li> back to a <p>
    const parent = existingList.parentNode!;
    const items = Array.from(existingList.querySelectorAll("li"));
    for (const li of items) {
      const p = document.createElement("p");
      while (li.firstChild) {
        p.appendChild(li.firstChild);
      }
      parent.insertBefore(p, existingList);
    }
    parent.removeChild(existingList);
    return;
  }

  // Check if we're in the opposite list type and should convert
  const otherTag = listTag === "UL" ? "OL" : "UL";
  const otherList = findAncestor(range.commonAncestorContainer, otherTag, editor);
  if (otherList) {
    const replacement = document.createElement(listTag);
    while (otherList.firstChild) {
      replacement.appendChild(otherList.firstChild);
    }
    otherList.parentNode!.replaceChild(replacement, otherList);
    return;
  }

  // Wrap the current block in a new list
  const block = findClosestBlock(range.startContainer, editor);
  const list = document.createElement(listTag);
  const li = document.createElement("li");

  if (block === editor) {
    // Wrap current selection contents
    const contents = range.extractContents();
    li.appendChild(contents.childNodes.length ? contents : document.createTextNode("\u200B"));
  } else {
    while (block.firstChild) {
      li.appendChild(block.firstChild);
    }
    block.parentNode!.replaceChild(list, block);
  }
  list.appendChild(li);
  if (!list.parentNode) {
    range.insertNode(list);
  }

  // Place cursor inside the list item
  const sel = window.getSelection();
  if (sel) {
    const newRange = document.createRange();
    newRange.selectNodeContents(li);
    newRange.collapse(false);
    sel.removeAllRanges();
    sel.addRange(newRange);
  }
}

export function useHtmlFormatting({ editorRef, onChange }: UseHtmlFormattingProps) {
  const { t } = useI18n();
  const historyRef = useRef<{ stack: string[]; index: number }>({
    stack: [],
    index: -1,
  });

  const pushHistory = useCallback(() => {
    if (!editorRef.current) return;
    const html = editorRef.current.innerHTML;
    const history = historyRef.current;

    // Truncate any redo entries beyond current position
    history.stack = history.stack.slice(0, history.index + 1);
    history.stack.push(html);

    // Cap the stack size
    if (history.stack.length > MAX_HISTORY) {
      history.stack = history.stack.slice(history.stack.length - MAX_HISTORY);
    }
    history.index = history.stack.length - 1;
  }, [editorRef]);

  const executeCommand = useCallback(
    (command: HtmlFormattingCommand) => {
      const editor = editorRef.current;
      if (!editor) return;

      editor.focus();

      // Undo/redo don't need to push history themselves
      if (command === "undo") {
        const history = historyRef.current;
        if (history.index < 0) return;
        // Save current state if we're at the latest position and haven't saved yet
        if (history.index === history.stack.length - 1) {
          const current = editor.innerHTML;
          if (history.stack[history.index] !== current) {
            history.stack.push(current);
            history.index = history.stack.length - 1;
          }
        }
        if (history.index > 0) {
          history.index--;
          editor.innerHTML = history.stack[history.index];
          onChange(editor.innerHTML);
        }
        return;
      }

      if (command === "redo") {
        const history = historyRef.current;
        if (history.index < history.stack.length - 1) {
          history.index++;
          editor.innerHTML = history.stack[history.index];
          onChange(editor.innerHTML);
        }
        return;
      }

      // Push current state onto history before making changes
      pushHistory();

      const range = getSelectionInEditor(editor);

      // --- Inline formatting ---
      const inlineTag = INLINE_TAG_MAP[command];
      if (inlineTag && range) {
        if (!range.collapsed) {
          toggleInlineTag(range, inlineTag, editor);
        }
        onChange(editor.innerHTML);
        return;
      }

      // --- Block formatting ---
      const blockTag = BLOCK_TAG_MAP[command];
      if (blockTag && range) {
        setBlockType(range, blockTag, editor);
        onChange(editor.innerHTML);
        return;
      }

      // --- Lists ---
      if ((command === "ul" || command === "ol") && range) {
        toggleList(range, command.toUpperCase(), editor);
        onChange(editor.innerHTML);
        return;
      }

      // --- Special operations ---
      switch (command) {
        case "br": {
          if (range) {
            range.deleteContents();
            const br = document.createElement("br");
            range.insertNode(br);
            // Move cursor after the <br>
            const sel = window.getSelection();
            if (sel) {
              const newRange = document.createRange();
              newRange.setStartAfter(br);
              newRange.collapse(true);
              sel.removeAllRanges();
              sel.addRange(newRange);
            }
          }
          break;
        }
        case "link": {
          if (range && !range.collapsed) {
            const url = prompt(t.products.formatting.linkPrompt);
            if (url) {
              const contents = range.extractContents();
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.target = "_blank";
              anchor.rel = "noopener";
              anchor.appendChild(contents);
              range.insertNode(anchor);
              const sel = window.getSelection();
              if (sel) {
                const newRange = document.createRange();
                newRange.selectNodeContents(anchor);
                sel.removeAllRanges();
                sel.addRange(newRange);
              }
            }
          }
          break;
        }
        case "unlink": {
          if (range) {
            const anchor = findAncestor(range.commonAncestorContainer, "A", editor);
            if (anchor) {
              unwrapElement(anchor);
            }
          }
          break;
        }
        case "removeFormat": {
          const selection = window.getSelection();
          const hasSelection =
            selection &&
            !selection.isCollapsed &&
            editor.contains(selection.anchorNode);

          if (hasSelection && range) {
            const plainText = selection.toString();
            range.deleteContents();
            range.insertNode(document.createTextNode(plainText));
          } else {
            const plainText = editor.textContent || "";
            editor.textContent = plainText;
          }
          break;
        }
      }

      onChange(editor.innerHTML);
    },
    [editorRef, onChange, pushHistory]
  );

  return { executeCommand, pushHistory };
}
