import type { CatalogItem } from "./types.ts";

/**
 * Entirely synthetic catalog. No real merchant, SKU, brand or price.
 * Prices are in minor units (cents).
 */
export const SYNTHETIC_CATALOG: CatalogItem[] = [
  {
    sku: "SYN-HOODIE-01",
    title: "Nebula Hoodie",
    currency: "USD",
    variants: [
      { variantId: "violet-m", label: "Violet / M", variantVersion: 1, priceVersion: 1, unitPriceMinor: 4200, available: true },
      { variantId: "violet-l", label: "Violet / L", variantVersion: 1, priceVersion: 1, unitPriceMinor: 4200, available: true },
      { variantId: "teal-m", label: "Teal / M", variantVersion: 1, priceVersion: 1, unitPriceMinor: 3900, available: true },
    ],
  },
  {
    sku: "SYN-SNEAKER-07",
    title: "Orbit Runner Sneaker",
    currency: "USD",
    variants: [
      { variantId: "white-9", label: "White / 9", variantVersion: 1, priceVersion: 1, unitPriceMinor: 8900, available: true },
      { variantId: "black-10", label: "Black / 10", variantVersion: 1, priceVersion: 1, unitPriceMinor: 8900, available: true },
    ],
  },
  {
    sku: "SYN-LAMP-03",
    title: "Lumen Desk Lamp",
    currency: "USD",
    variants: [
      { variantId: "std", label: "Standard", variantVersion: 1, priceVersion: 1, unitPriceMinor: 2900, available: true },
    ],
  },
];
