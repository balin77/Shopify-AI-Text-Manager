/**
 * Item Selector Context
 *
 * Provides current items and selection state to the mobile navbar.
 * Content editor pages can register their items here for display in the compact navbar selector.
 */

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import type { UnifiedItem } from "../components/unified/UnifiedItemList";

interface ItemSelectorContextValue {
  /** Current items available for selection */
  items: UnifiedItem[];
  /** Currently selected item ID */
  selectedItemId: string | null;
  /** Callback when item is selected */
  onItemSelect: ((itemId: string) => void) | null;
  /** Resource name for display */
  resourceName: { singular: string; plural: string };
  /** Translation strings */
  t: {
    searchPlaceholder?: string;
    noResults?: string;
    selectItem?: string;
  };
  /** Register items from a content editor page */
  registerItems: (config: {
    items: UnifiedItem[];
    selectedItemId: string | null;
    onItemSelect: (itemId: string) => void;
    resourceName: { singular: string; plural: string };
    t?: {
      searchPlaceholder?: string;
      noResults?: string;
      selectItem?: string;
    };
  }) => void;
  /** Clear items when leaving content editor page */
  clearItems: () => void;
}

const ItemSelectorContext = createContext<ItemSelectorContextValue | undefined>(undefined);

export function ItemSelectorProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<UnifiedItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [onItemSelect, setOnItemSelect] = useState<((itemId: string) => void) | null>(null);
  const [resourceName, setResourceName] = useState<{ singular: string; plural: string }>({
    singular: "Item",
    plural: "Items",
  });
  const [t, setT] = useState<{
    searchPlaceholder?: string;
    noResults?: string;
    selectItem?: string;
  }>({});

  const registerItems = useCallback((config: {
    items: UnifiedItem[];
    selectedItemId: string | null;
    onItemSelect: (itemId: string) => void;
    resourceName: { singular: string; plural: string };
    t?: {
      searchPlaceholder?: string;
      noResults?: string;
      selectItem?: string;
    };
  }) => {
    setItems(config.items);
    setSelectedItemId(config.selectedItemId);
    setOnItemSelect(() => config.onItemSelect);
    setResourceName(config.resourceName);
    setT(config.t || {});
  }, []);

  const clearItems = useCallback(() => {
    setItems([]);
    setSelectedItemId(null);
    setOnItemSelect(null);
    setResourceName({ singular: "Item", plural: "Items" });
    setT({});
  }, []);

  return (
    <ItemSelectorContext.Provider
      value={{
        items,
        selectedItemId,
        onItemSelect,
        resourceName,
        t,
        registerItems,
        clearItems,
      }}
    >
      {children}
    </ItemSelectorContext.Provider>
  );
}

export function useItemSelector() {
  const context = useContext(ItemSelectorContext);
  if (context === undefined) {
    throw new Error("useItemSelector must be used within an ItemSelectorProvider");
  }
  return context;
}
