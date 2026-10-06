# Search rewrite

## Destination

A spec for replacing Postgres LIKE product search, ready to hand to /to-spec.

## Notes

Domain: catalog + storefront. Pull /domain-modeling for Listing vs Product.

## Decisions so far

- [Typesense vs Meilisearch vs pg_trgm](issues/01-engine-research.md): Typesense Cloud; pg_trgm misses p95 at 2M SKUs

## Not yet specified

- Stemming for the DE/FR storefronts
- Zero-result analytics

## Out of scope

- Voice search: no voice surface in the storefront
