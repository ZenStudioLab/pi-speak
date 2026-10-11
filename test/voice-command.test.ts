import assert from "node:assert/strict";
import { test } from "node:test";
import { collapse, matchVoiceCommand, type CommandAlias, type VoiceMatch, type VoiceMode } from "../voice-command.ts";

const listed = {
  commands: ["opsx", "opsx-apply", "opsx-apply-loop", "deploy", "deploy:2", "review", "foo-bar", "foobar", "abcdefghi", "online-llm-interactive", "staging-deploy", "red-green-fast", "fast-red-green", "go-go-stop", "opsx-sync"],
  skills: ["review-convergence", "design-an-interface"],
};
const alias = (phrase: string, target: string): CommandAlias => ({ phrase, target });
const match = (target: string, args: string, isListed = true): VoiceMatch => ({ kind: "match", target, args, listed: isListed });
const NONE: VoiceMatch = { kind: "none" };

for (const [name, mode, transcript, aliases, expected] of [
  ["the longest run of words wins", "command", "op sx apply loop, add speak voice input.", [], match("/opsx-apply-loop", "add speak voice input")],
  ["a shorter name wins when the longer one is not spoken", "command", "Opsx apply the change", [], match("/opsx-apply", "the change")],
  ["case, punctuation, hyphens and colons are ignored", "command", "OPSX-Apply:Loop", [], match("/opsx-apply-loop", "")],
  ["an alias beats a name of the same collapsed form", "command", "review the diff", [alias("Review", "/opsx-review-all")], match("/opsx-review-all", "the diff", false)],
  ["a longer name beats a shorter alias", "command", "opsx apply loop now", [alias("opsx", "/other")], match("/opsx-apply-loop", "now")],
  ["two different names with one collapsed form are ambiguous", "command", "foo bar baz", [], { kind: "ambiguous", names: ["foo-bar", "foobar"] }],
  ["an alias settles what two names leave ambiguous", "command", "foobar", [alias("foo bar", "/foobar")], match("/foobar", "")],
  ["only the first eight words can spell a name", "command", "a b c d e f g h i", [], NONE],
  ["an eight-word alias matches and leaves the ninth word as the arguments", "command", "a b c d e f g h i", [alias("a b c d e f g h", "/model")], match("/model", "i", false)],
  ["an alias phrase matches precomposed Vietnamese text", "command", "M\u00f4 h\u00ecnh.", [alias("m\u00f4 h\u00ecnh", "/model")], match("/model", "", false)],
  ["an alias phrase matches decomposed Vietnamese text", "command", "Mo\u0302 hi\u0300nh.", [alias("m\u00f4 h\u00ecnh", "/model")], match("/model", "", false)],
  ["a decomposed alias phrase matches precomposed Vietnamese text", "command", "M\u00f4 h\u00ecnh.", [alias("Mo\u0302 hi\u0300nh", "/model")], match("/model", "", false)],
  ["a full stop ends the arguments", "command", "deploy staging.", [], match("/deploy", "staging")],
  ["a question mark ends the arguments", "command", "deploy staging?", [], match("/deploy", "staging")],
  ["an ellipsis ends the arguments", "command", "deploy staging…", [], match("/deploy", "staging")],
  ["commas separate the arguments inside and are trimmed at the ends", "command", "deploy, staging, now.", [], match("/deploy", "staging, now")],
  ["a lone dash after the name is dropped", "command", "deploy — add tests", [], match("/deploy", "add tests")],
  ["whitespace between words becomes single spaces", "command", "  deploy \n  add   tests  ", [], match("/deploy", "add tests")],
  ["a suffixed duplicate is matched by its collapsed form", "command", "deploy 2 now", [], match("/deploy:2", "now")],
  ["the plain name wins when no suffix is spoken", "command", "deploy now", [], match("/deploy", "now")],
  ["a skill becomes /skill:<name>", "skill", "Review convergence.", [], match("/skill:review-convergence", "")],
  ["skill arguments follow the name", "skill", "design an interface for the loader", [], match("/skill:design-an-interface", "for the loader")],
  ["skill mode ignores commands", "skill", "deploy", [], NONE],
  ["command mode ignores skills", "command", "review convergence", [], match("/review", "convergence")],
  ["skill mode ignores command aliases", "skill", "converge", [alias("converge", "/model")], NONE],
  ["command mode ignores /skill: aliases", "command", "converge", [alias("converge", "/skill:review-convergence")], NONE],
  ["an alias to a listed command is a listed target", "command", "loop it", [alias("loop it", "/opsx-apply-loop extra words")], match("/opsx-apply-loop extra words", "", true)],
  ["an alias to a listed skill is a listed target", "skill", "converge", [alias("converge", "/skill:review-convergence")], match("/skill:review-convergence", "", true)],
  ["an alias to a skill that is not listed is an unlisted target", "skill", "converge", [alias("converge", "/skill:gone")], match("/skill:gone", "", false)],
  ["an alias to a command that is not listed is an unlisted target", "command", "model", [alias("model", "/model")], match("/model", "", false)],
  ["words in another order match, and the rest are the arguments", "command", "LLM online interactive, check the spec.", [], match("/online-llm-interactive", "check the spec")],
  ["a free-standing dash among words in another order is not a word", "command", "LLM — online interactive", [], match("/online-llm-interactive", "")],
  ["a reordered alias phrase matches, and an alias beats a name with the same words", "command", "interactive llm online", [alias("online interactive llm", "/other")], match("/other", "", false)],
  ["words in another order match skills in skill mode", "skill", "convergence review the diff", [], match("/skill:review-convergence", "the diff")],
  ["a name that matches in order beats a longer run that matches only in another order", "command", "deploy staging", [], match("/deploy", "staging")],
  ["two names with the same words in another order are ambiguous", "command", "green red fast", [], { kind: "ambiguous", names: ["red-green-fast", "fast-red-green"] }],
  ["repeated words are counted, not merged", "command", "stop go go now", [], match("/go-go-stop", "now")],
  ["a word spoken twice does not stand for a word spoken once", "command", "stop stop go", [], NONE],
  ["a word spoken in parts matches in order", "command", "op sx sync it", [], match("/opsx-sync", "it")],
  ["a word spoken in parts does not match in another order", "command", "sync op sx", [], NONE],
  ["words that match nothing", "command", "order a pizza", [], NONE],
  ["an empty transcript", "command", "", [], NONE],
  ["a blank transcript", "skill", "  \n ", [], NONE],
  ["a transcript of punctuation only", "command", "… ?", [], NONE],
] as [string, VoiceMode, string, CommandAlias[], VoiceMatch][])
  test(`voice match: ${name}`, () => {
    assert.deepEqual(matchVoiceCommand(transcript, mode, listed, aliases), expected);
  });

test("collapse keeps letters and digits only, in NFKC lower case", () => {
  assert.equal(collapse("Op SX apply-loop"), "opsxapplyloop");
  assert.equal(collapse("Ｄeploy:2"), "deploy2");
  assert.equal(collapse("?! –"), "");
});
