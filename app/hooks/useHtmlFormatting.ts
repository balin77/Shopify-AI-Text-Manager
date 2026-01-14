import { useCallback } from "react";

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

export function useHtmlFormatting({ editorRef, onChange }: UseHtmlFormattingProps) {
  const executeCommand = useCallback(
    (command: HtmlFormattingCommand) => {
      if (!editorRef.current) return;

      editorRef.current.focus();

      switch (command) {
        case "bold":
          document.execCommand("bold", false);
          break;
        case "italic":
          document.execCommand("italic", false);
          break;
        case "underline":
          document.execCommand("underline", false);
          break;
        case "strikethrough":
          document.execCommand("strikeThrough", false);
          break;
        case "h1":
          document.execCommand("formatBlock", false, "<h1>");
          break;
        case "h2":
          document.execCommand("formatBlock", false, "<h2>");
          break;
        case "h3":
          document.execCommand("formatBlock", false, "<h3>");
          break;
        case "p":
          document.execCommand("formatBlock", false, "<p>");
          break;
        case "ul":
          document.execCommand("insertUnorderedList", false);
          break;
        case "ol":
          document.execCommand("insertOrderedList", false);
          break;
        case "br":
          document.execCommand("insertHTML", false, "<br>");
          break;
        case "blockquote":
          document.execCommand("formatBlock", false, "<blockquote>");
          break;
        case "code":
          document.execCommand("formatBlock", false, "<pre>");
          break;
        case "link":
          const url = prompt("URL eingeben:");
          if (url) {
            document.execCommand("createLink", false, url);
          }
          break;
        case "unlink":
          document.execCommand("unlink", false);
          break;
        case "undo":
          document.execCommand("undo", false);
          break;
        case "redo":
          document.execCommand("redo", false);
          break;
        case "removeFormat":
          document.execCommand("removeFormat", false);
          break;
      }

      onChange(editorRef.current.innerHTML);
    },
    [editorRef, onChange]
  );

  return { executeCommand };
}
