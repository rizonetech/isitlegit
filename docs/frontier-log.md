# Frontier log

One experiment per build day at the edge of what Meta's models can do (design spec 4.9, `docs/manifesto.md`). Each entry records what was tried, on which synthetic inputs, what happened and what it means for IsItLegit. What works becomes a feature through `todo/`; what fails stays here with its evidence, because knowing where a model breaks is as useful as knowing where it shines.

Entry format:

```markdown
## YYYY-MM-DD: <the question, in one line>

- Model and settings: <model ID, reasoning effort, tools, structured output>
- Inputs: <synthetic files or prompts, paths under eval/ or test/>
- Result: <what happened, with numbers: accuracy, time, cost>
- Meaning: <feature, cut, or open question; the TODO section it feeds>
```

The first experiment runs on Tue 27 Oct, once the Meta Model API credit is live.
