/**
 * EditableKeywordCell — the keyword column of the library table, editable in
 * place.
 *
 * Reading state is a plain text button (the whole label is the hit area, with
 * a pencil affordance on hover); editing state is a TextField that commits on
 * Enter OR on blur and discards on Escape. A freshly added row arrives already
 * in editing state, which is why `editing` is owned by the parent rather than
 * here — the Shell flips it when the create action answers with the new id.
 *
 * The draft text is local: it must survive the loader revalidations that any
 * other action on the page triggers, and it must NOT be pushed into the
 * parent on every keystroke.
 *
 * Polaris' TextField forwards neither a ref nor onKeyDown, so focus+select
 * come from its own `autoFocus`/`selectTextOnFocus` props and the key handling
 * sits on a wrapper the input's events bubble through.
 */

import { useEffect, useRef, useState } from "react";
import { BlockStack, Text, TextField } from "@shopify/polaris";
import type { Translation } from "../../../i18n/de";

type KeywordsPageStrings = Translation["seo"]["keywordsPage"];

export interface EditableKeywordCellProps {
  k: KeywordsPageStrings;
  keywordId: string;
  keyword: string;
  editing: boolean;
  /** Server-side rejection for THIS row (e.g. the language already has it). */
  error?: string;
  busy: boolean;
  onStartEdit: () => void;
  onCancel: () => void;
  /** Called only when the text actually changed; an unchanged edit just closes. */
  onCommit: (next: string) => void;
}

export function EditableKeywordCell({
  k,
  keywordId,
  keyword,
  editing,
  error,
  busy,
  onStartEdit,
  onCancel,
  onCommit,
}: EditableKeywordCellProps) {
  const [draft, setDraft] = useState(keyword);
  // Enter commits and the field then loses focus; without this the blur
  // handler would fire a second submit for the same edit.
  const committedRef = useRef(false);

  // Re-seed whenever this cell (re)enters editing — including the row that was
  // just created, whose name the server generated.
  useEffect(() => {
    if (editing) {
      setDraft(keyword);
      committedRef.current = false;
    }
    // The keyword text is the seed, not a dependency: re-seeding mid-edit
    // because a revalidation returned the old value would eat the typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, keywordId]);

  // Re-arm once the server has answered. A REJECTED rename (the language
  // already has that keyword) leaves the cell open on the same row, so the
  // re-seed effect above does not re-run — without this the guard would stay
  // latched and neither Enter nor blur could ever submit the corrected name
  // again, leaving Escape as the only way out.
  useEffect(() => {
    if (!busy) committedRef.current = false;
  }, [busy]);

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    const next = draft.trim();
    if (!next || next === keyword) {
      onCancel();
      return;
    }
    onCommit(next);
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={onStartEdit}
        className="keyword-inline-edit"
        aria-label={k.editKeywordHint.replace("{keyword}", keyword)}
      >
        <Text as="span" variant="bodyMd">
          {keyword}
        </Text>
        <span aria-hidden="true" className="keyword-inline-edit__pencil">
          ✎
        </span>
      </button>
    );
  }

  return (
    <BlockStack gap="100">
      <div
        style={{ minWidth: "180px", maxWidth: "320px" }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            committedRef.current = true;
            onCancel();
          }
        }}
      >
        <TextField
          label={k.colKeyword}
          labelHidden
          autoComplete="off"
          value={draft}
          onChange={setDraft}
          disabled={busy}
          error={!!error}
          maxLength={120}
          autoFocus
          selectTextOnFocus
          onBlur={commit}
        />
      </div>
      <Text as="span" variant="bodySm" tone={error ? "critical" : "subdued"}>
        {error ?? k.editKeywordCommitHint}
      </Text>
    </BlockStack>
  );
}
