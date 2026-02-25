/**
 * Utilities for working with Shopify product data
 */

/**
 * Returns true if the given Shopify product option is the internal
 * "Default Title" placeholder that Shopify creates for products with no
 * real variants. These options are hidden in the Shopify admin but are
 * exposed through the API and should be filtered out everywhere.
 *
 * Shopify's internal default: name = "Title", single value = "Default Title"
 */
export function isDefaultTitleOption(opt: {
  name: string;
  optionValues?: Array<{ name: string }>;
  values?: string[];
}): boolean {
  if (opt.name !== "Title") return false;

  // Check using optionValues (GraphQL object form)
  if (opt.optionValues) {
    return opt.optionValues.length === 1 && opt.optionValues[0].name === "Default Title";
  }

  // Check using values (string array form)
  if (opt.values) {
    return opt.values.length === 1 && opt.values[0] === "Default Title";
  }

  return false;
}
