// Every buildList fixture, by file name. Add a fixture: drop a JSON file next to this one, import
// it here, and aggregate.test.ts checks it with no further code.
import chickenLbAndOz from "./chicken-lb-and-oz.json";
import container28ozDoubleBuy from "./container-28oz-double-buy.json";
import containerColumns from "./container-columns.json";
import containerRawText from "./container-raw-text.json";
import containerWithWeight from "./container-with-weight.json";
import entryStatuses from "./entry-statuses.json";
import garlicCloveAndHead from "./garlic-clove-and-head.json";
import type { ListFixture } from "./harness.ts";
import mixedUnitsSplit from "./mixed-units-split.json";
import onionTwoRecipes from "./onion-two-recipes.json";
import optionalAndToTaste from "./optional-and-to-taste.json";
import pantryHave from "./pantry-have.json";
import qualifiersNeverMerge from "./qualifiers-never-merge.json";
import rangeUsesUpperBound from "./range-uses-upper-bound.json";
import scale4To6 from "./scale-4-to-6.json";
import sectionsDefaultOrder from "./sections-default-order.json";
import sectionsHouseholdOrder from "./sections-household-order.json";
import unparsedLine from "./unparsed-line.json";
import weekOfFiveDinners from "./week-of-five-dinners.json";

export const FIXTURES: Readonly<Record<string, ListFixture>> = {
  "chicken-lb-and-oz": chickenLbAndOz as ListFixture,
  "container-28oz-double-buy": container28ozDoubleBuy as ListFixture,
  "container-columns": containerColumns as ListFixture,
  "container-raw-text": containerRawText as ListFixture,
  "container-with-weight": containerWithWeight as ListFixture,
  "entry-statuses": entryStatuses as ListFixture,
  "garlic-clove-and-head": garlicCloveAndHead as ListFixture,
  "mixed-units-split": mixedUnitsSplit as ListFixture,
  "onion-two-recipes": onionTwoRecipes as ListFixture,
  "optional-and-to-taste": optionalAndToTaste as ListFixture,
  "pantry-have": pantryHave as ListFixture,
  "qualifiers-never-merge": qualifiersNeverMerge as ListFixture,
  "range-uses-upper-bound": rangeUsesUpperBound as ListFixture,
  "scale-4-to-6": scale4To6 as ListFixture,
  "sections-default-order": sectionsDefaultOrder as ListFixture,
  "sections-household-order": sectionsHouseholdOrder as ListFixture,
  "unparsed-line": unparsedLine as ListFixture,
  "week-of-five-dinners": weekOfFiveDinners as ListFixture,
};
