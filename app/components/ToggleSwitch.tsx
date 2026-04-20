interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
}

export function ToggleSwitch({ checked, onChange, disabled = false, id }: ToggleSwitchProps) {
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
