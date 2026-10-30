// The full seeded ontology in memory, for unit tests and the golden-set eval. Node only.

import { readSeed } from "../../../supabase/seed/load.ts";
import { InMemoryOntology } from "../src/ontology.ts";

export function seedOntology(): InMemoryOntology {
  const seed = readSeed();
  return new InMemoryOntology({
    ingredients: seed.ingredients.map((i) => ({
      ingredientId: i.id,
      name: i.name,
      category: i.category,
      plural: i.plural,
    })),
    aliases: seed.aliases,
  });
}
