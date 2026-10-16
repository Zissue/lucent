// @ts-check

const script = require("lucent/script");
const s = require("lucent/schema");
const { spinWheelOfDoom } = require("@lucent/dailies");

const bankRewardsSchema = s.boolean().default(false);

function* run() {
  const bankRewards = bankRewardsSchema.parse(
    yield* script.inputs.get("bankRewards"),
  );
  const result = yield* spinWheelOfDoom({ bankRewards });
  // optionally:
  // yield* script.log(result);
  return result;
}

module.exports = run;

/** @satisfies {import("lucent/script").ScriptInputsDefinition} */
module.exports.inputs = {
  id: "lucent-dailies-spin-wheel-of-doom",
  fields: [
    {
      key: "bankRewards",
      type: "boolean",
      label: "Bank rewards",
      description: "Deposit wheel rewards after each successful spin.",
      default: false,
    },
  ],
};
