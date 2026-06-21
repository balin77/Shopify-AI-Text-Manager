/**
 * Plan Context
 * Provides subscription plan information throughout the app
 */

import { createContext, useContext, useMemo, useCallback, type ReactNode } from "react";
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
  getMaxForResource,
  getUsagePercentage,
  isApproachingLimit,
  isAtLimit,
  getResourcesApproachingLimits,
  getMinimumPlanForContentType,
  canAccessVariantImageManagerInEnv,
  canAccessImageProcessingTab as utilCanAccessImageProcessingTab,
  canAccessImageManagerSettingsTab as utilCanAccessImageManagerSettingsTab,
  type ResourceType,
} from "../utils/planUtils";

interface PlanContextValue {
  plan: Plan;
  newFeaturesEnabled: boolean;
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
  // New limit functions
  getMaxForResource: (resourceType: ResourceType) => number;
  getUsagePercentage: (resourceType: ResourceType, currentCount: number) => number;
  isApproachingLimit: (resourceType: ResourceType, currentCount: number, threshold?: number) => boolean;
  isAtLimit: (resourceType: ResourceType, currentCount: number) => boolean;
  getResourcesApproachingLimits: (counts: Record<ResourceType, number>, threshold?: number) => ResourceType[];
  // Production-locked feature checks
  canAccessVariantImageManager: () => boolean;
  canAccessImageProcessingTab: () => boolean;
  canAccessImageManagerSettingsTab: () => boolean;
}

const PlanContext = createContext<PlanContextValue | null>(null);

interface PlanProviderProps {
  plan: Plan;
  newFeaturesEnabled: boolean;
  children: ReactNode;
}

export function PlanProvider({ plan, newFeaturesEnabled, children }: PlanProviderProps) {
  const value: PlanContextValue = useMemo(() => ({
    plan,
    newFeaturesEnabled,
    getPlanLimits: () => getPlanLimits(plan),
    canAccessContentType: (contentType: ContentType) => utilCanAccessContentType(plan, contentType),
    isWithinProductLimit: (currentCount: number) => utilIsWithinProductLimit(plan, currentCount),
    getNextPlanUpgrade: () => getNextPlanUpgrade(plan),
    getPlanDisplayName: () => getPlanDisplayName(plan),
    canEditAIInstructions: () => canEditAIInstructions(plan),
    shouldCacheAllProductImages: () => shouldCacheAllProductImages(plan),
    getAccessibleContentTypes: () => getAccessibleContentTypes(plan),
    getMaxProducts: () => getPlanLimits(plan).maxProducts,
    // New limit functions
    getMaxForResource: (resourceType: ResourceType) => getMaxForResource(plan, resourceType),
    getUsagePercentage: (resourceType: ResourceType, currentCount: number) => getUsagePercentage(plan, resourceType, currentCount),
    isApproachingLimit: (resourceType: ResourceType, currentCount: number, threshold?: number) => isApproachingLimit(plan, resourceType, currentCount, threshold),
    isAtLimit: (resourceType: ResourceType, currentCount: number) => isAtLimit(plan, resourceType, currentCount),
    getResourcesApproachingLimits: (counts: Record<ResourceType, number>, threshold?: number) => getResourcesApproachingLimits(plan, counts, threshold),
    // Production-locked feature checks
    canAccessVariantImageManager: () => canAccessVariantImageManagerInEnv(plan, newFeaturesEnabled),
    canAccessImageProcessingTab: () => utilCanAccessImageProcessingTab(plan, newFeaturesEnabled),
    canAccessImageManagerSettingsTab: () => utilCanAccessImageManagerSettingsTab(plan, newFeaturesEnabled),
  }), [plan, newFeaturesEnabled]);

  return <PlanContext.Provider value={value}>{children}</PlanContext.Provider>;
}

export function usePlan() {
  const context = useContext(PlanContext);
  if (!context) {
    throw new Error("usePlan must be used within a PlanProvider");
  }
  return context;
}
