export const meta = {
  name: "hello",
  description: "Ask one leaf for a structured greeting",
  phases: [{ title: "Greet" }],
};

const selection = {};
if (args?.backend) {
  selection.backend = args.backend;
}
if (args?.model) {
  selection.model = args.model;
}
return agent("Return a greeting of at most five words.", {
  ...selection,
  label: "Greeting",
  schema: {
    type: "object",
    properties: { greeting: { type: "string" } },
    required: ["greeting"],
    additionalProperties: false,
  },
});
