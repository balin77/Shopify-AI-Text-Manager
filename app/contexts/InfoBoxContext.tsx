import { createContext, useContext, useState, ReactNode } from "react";

export type InfoBoxTone = "success" | "info" | "warning" | "critical";

export interface InfoBoxState {
  message: string;
  tone: InfoBoxTone;
  title?: string;
}

interface InfoBoxContextType {
  infoBox: InfoBoxState | null;
  showInfoBox: (message: string, tone?: InfoBoxTone, title?: string) => void;
  hideInfoBox: () => void;
}

const InfoBoxContext = createContext<InfoBoxContextType | undefined>(undefined);

export function InfoBoxProvider({ children }: { children: ReactNode }) {
  const [infoBox, setInfoBox] = useState<InfoBoxState | null>(null);

  const showInfoBox = (message: string, tone: InfoBoxTone = "success", title?: string) => {
    setInfoBox({ message, tone, title });

    // Auto-hide nach 5 Sekunden bei success oder info
    if (tone === "success" || tone === "info") {
      setTimeout(() => {
        setInfoBox(null);
      }, 5000);
    }
  };

  const hideInfoBox = () => {
    setInfoBox(null);
  };

  return (
    <InfoBoxContext.Provider value={{ infoBox, showInfoBox, hideInfoBox }}>
      {children}
    </InfoBoxContext.Provider>
  );
}

export function useInfoBox() {
  const context = useContext(InfoBoxContext);
  if (context === undefined) {
    throw new Error("useInfoBox must be used within an InfoBoxProvider");
  }
  return context;
}
