import { describe, expect, it } from "vitest";
import { detectLanguage, sanitize } from "../src/speech.js";

describe("detectLanguage", () => {
  it("detects Portuguese", () => {
    expect(detectLanguage("Não está pronto, vou executar os testes")).toBe("pt");
  });

  it("detects English", () => {
    expect(detectLanguage("The build is done, please run the tests")).toBe("en");
  });

  it("detects French", () => {
    expect(detectLanguage("Bonjour, vous avez la merci pour le test")).toBe("fr");
  });

  it("defaults to English when the text is inconclusive", () => {
    expect(detectLanguage("42")).toBe("en");
    expect(detectLanguage("!!!")).toBe("en");
  });

  it("keeps Portuguese with lone English keywords (code talk)", () => {
    expect(detectLanguage("Criei um loop for para percorrer a lista.")).toBe("pt");
    expect(detectLanguage("Usa o with para gerir o contexto.")).toBe("pt");
    expect(detectLanguage("O this refere-se à instância.")).toBe("pt");
    expect(detectLanguage("Vou fazer o deploy agora.")).toBe("pt");
    expect(detectLanguage("Fiz merge da branch principal.")).toBe("pt");
  });

  it("lets the majority win on mixed messages", () => {
    expect(detectLanguage("Sure! Vou verificar isso.")).toBe("pt");
    expect(detectLanguage("Sure! Let me check that for you.")).toBe("en");
    expect(detectLanguage("Thank you!")).toBe("en");
    expect(detectLanguage("Obrigado pela ajuda!")).toBe("pt");
  });
});

describe("sanitize", () => {
  it("strips code, markup and URLs", () => {
    expect(sanitize("**Hello** `code` https://example.com", 0)).toBe("Hello");
    expect(sanitize("```js\nconst x = 1\n```", 0)).toBe("");
  });

  it("truncates to the limit", () => {
    expect(sanitize("one two three", 7)).toBe("one two");
  });
});
