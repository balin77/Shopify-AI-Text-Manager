interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  /**
   * What this switch decides.
   *
   * The visible text sits BESIDE the switch rather than inside its `<label>`,
   * so without this the control has no accessible name at all — a screen
   * reader announces "checkbox" and nothing else.
   */
  ariaLabel?: string;
}

export function ToggleSwitch({ checked, onChange, disabled = false, id, ariaLabel }: ToggleSwitchProps) {
  return (
    <label
      style={{
        position: "relative",
        display: "inline-block",
        width: 44,
        height: 24,
        cursor: disabled ? "not-allowed" : "pointer",
        flexShrink: 0,
      }}
    >
      <input
        id={id}
        type="checkbox"
        role="switch"
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
        style={{ opacity: 0, width: 0, height: 0, position: "absolute" }}
      />
      <span
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 12,
          backgroundColor: checked ? "#008060" : "#8c9196",
          transition: "background-color 0.2s ease",
          opacity: disabled ? 0.5 : 1,
        }}
      />
      <span
        style={{
          position: "absolute",
          top: 3,
          left: checked ? 23 : 3,
          width: 18,
          height: 18,
          borderRadius: "50%",
          backgroundColor: "#ffffff",
          boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
          transition: "left 0.2s ease",
        }}
      />
    </label>
  );
}
