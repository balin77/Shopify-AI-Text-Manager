/**
 * Plan Context
 * Provides subscription plan information throughout the app
 */

import { createContext, useContext, type ReactNode } from "react";
import { type Plan, type ContentType } from "../config/plans";
import {
  getPlanLimits,
  canAccessContentType as utilCanAccessContentType,
  isWithinProductLimit as utilIsWithinProductLimit,
  getNextPlanUpgrade,
  getPlanDisplayName,
  canEditAIInstructions,
  shouldCacheAllProductImages,
  getAccessibleContentTypes,
} from "../utils/planUtils";

interface PlanContextValue {
  plan: Plan;
  // Plan queries
  getPlanLimits: () => ReturnType<typeof getPlanLimits>;
  canAccessContentType: (contentType: ContentType) => boolean;
  isWithinProductLimit: (currentCount: number) => boolean;
  getNextPlanUpgrade: () => Plan | null;
  getPlanDisplayName: () => string;
  canEditAIInstructions: () => boolean;
  shouldCacheAllProductImages: () => boolean;
  getAccessibleContentTypes: () => ContentType[];
  getMaxProducts: () => number;
}

const PlanContext = createContext<PlanContextValue | null>(null);

interface PlanProviderProps {
  plan: Plan;
  children: ReactNode;
}

export function PlanProvider({ plan, children }: PlanProviderProps) {
  const value: PlanContextValue = {
    plan,
    getPlanLimits: () => getPlanLimits(plan),
    canAccessContentType: (contentType: ContentType) => utilCanAccessContentType(plan, contentType),
    isWithinProductLimit: (currentCount: number) => utilIsWithinProductLimit(plan, currentCount),
    getNextPlanUpgrade: () => getNextPlanUpgrade(plan),
    getPlanDisplayName: () => getPlanDisplayName(plan),
    canEditAIInstructions: () => canEditAIInstructions(plan),
    shouldCacheAllProductImages: () => shouldCacheAllProductImages(plan),
    getAccessibleContentTypes: () => getAccessibleContentTypes(plan),
    getMaxProducts: () => getPlanLimits(plan).maxProducts,
  };

  return <PlanContext.Provider value={value}>{children}</PlanContext.Provider>;
}

export function usePlan() {
  const context = useContext(PlanContext);
  if (!context) {
    throw new Error("usePlan must be used within a PlanProvider");
  }
  return context;
}
