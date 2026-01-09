import { useState, useEffect } from "react";

export function useAISuggestions(fetcherData: any) {
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, string>>({});

  // Handle AI generation response
  useEffect(() => {
    if (fetcherData?.success && fetcherData.generatedContent) {
      const fieldType = fetcherData.fieldType;
      setAiSuggestions(prev => ({
        ...prev,
        [fieldType]: fetcherData.generatedContent,
      }));
    }
  }, [fetcherData]);

  const removeSuggestion = (fieldType: string) => {
    setAiSuggestions(prev => {
      const newSuggestions = { ...prev };
      delete newSuggestions[fieldType];
      return newSuggestions;
    });
  };

  return {
    aiSuggestions,
    setAiSuggestions,
    removeSuggestion,
  };
}
