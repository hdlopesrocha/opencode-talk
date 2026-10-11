/**
 * Shared language detection for TTS voice selection (local speakers and the
 * Telegram talk bridge). Scores distinctive words per language instead of
 * first-match, so a lone English keyword inside Portuguese prose (e.g. a bare
 * `for` while explaining a loop) no longer flips the whole reply to English.
 * Inconclusive text (numbers, very short replies) defaults to English.
 */

const EN_WORDS = new Set([
  "the", "and", "you", "your", "yours", "this", "that", "these", "those", "with", "without",
  "for", "from", "are", "is", "was", "were", "be", "been", "have", "has", "had", "will",
  "would", "can", "could", "should", "may", "might", "must", "not", "but", "they", "them",
  "there", "here", "what", "when", "where", "which", "who", "how", "why", "please", "thanks",
  "thank", "hello", "yes", "okay", "error", "errors", "warning", "file", "files", "code",
  "test", "tests", "run", "running", "install", "update", "updates", "note", "let", "use",
  "using", "add", "added", "need", "want", "see", "now", "then", "also", "or", "if", "so",
  "up", "out", "we", "he", "she", "it", "in", "my", "mine", "our", "her", "his", "does",
  "did", "make", "made", "take", "come", "go", "get", "show", "create", "change", "open",
  "close", "read", "write", "check", "fix", "found", "result", "results", "output", "example",
  "examples", "message", "messages", "value", "values", "method", "methods", "variable",
  "variables", "folder", "folders", "issue", "issues", "sure", "sorry", "great", "perfect",
  "nice", "awesome", "exactly", "actually", "however", "since", "despite", "unless", "until",
  "within", "across", "instead", "often", "usually", "already", "almost", "always", "never",
  "sometimes", "together", "again", "very", "really", "quite", "enough", "much", "many",
  "only", "into", "over", "after", "before", "between", "through", "during", "because",
  "while", "expected", "actual", "current", "previous", "following", "missing", "wrong",
  "correct", "failed", "passed", "skipped", "question", "questions", "answer", "answers",
  "report", "summary", "details", "steps", "function", "functions", "number", "numbers",
  "object", "objects", "list", "return", "returns", "enter", "send", "click", "down", "load",
  "save", "delete", "insert", "select", "diff", "patch", "lint", "format", "parse", "compile",
  "bundle", "fetch", "clone", "fork", "pick", "first", "second", "third", "today", "yesterday",
  "tomorrow", "simply", "especially", "generally", "typically", "normally", "currently",
  "recently", "previously", "finally", "basically", "overall", "anyway", "meanwhile",
  "otherwise", "although", "though", "even", "still", "yet", "both", "each", "every",
  "everything", "everyone", "everywhere", "anything", "anyone", "anywhere", "something",
  "someone", "somewhere", "nothing", "nobody", "nowhere", "some", "any", "become", "became",
  "seem", "appear", "remain", "stay", "keep", "contain", "include", "provide", "require",
  "allow", "ensure", "handle", "process", "generate", "produce", "accept", "reject", "filter",
  "sort", "apply", "call", "invoke", "pass", "skip", "ignore", "match", "equal", "compare",
  "differ", "depend", "break", "reading", "writing", "user", "vs", "plus", "well", "english",
]);

const PT_WORDS = new Set([
  "não", "nao", "está", "esta", "estás", "estou", "estamos", "você", "voce", "para", "com",
  "uma", "um", "uns", "umas", "isso", "isto", "esse", "essa", "aquilo", "também", "tambem",
  "já", "ja", "muito", "muita", "obrigado", "obrigada", "olá", "ola", "sim", "então", "entao",
  "porque", "quando", "onde", "como", "fazer", "feito", "ficheiro", "ficheiros", "erro", "erros",
  "teste", "testes", "testar", "executar", "instalar", "atualizar", "código", "codigo", "vou",
  "vamos", "aqui", "ali", "depois", "antes", "mais", "menos", "será", "sera", "seu", "sua",
  "seus", "suas", "nosso", "nossa", "estão", "estao", "é", "são", "sao", "tem", "têm", "tenho",
  "pode", "podem", "quero", "quer", "preciso", "precisa", "voz", "texto", "mensagem", "mensagens",
  "que", "fala", "falam", "diz", "dizem", "faz", "fazem", "cria", "criam", "mostra", "mostram",
  "testa", "testam", "abre", "abrem", "fecha", "fecham", "muda", "mudam", "tenta", "tentam",
  "tentar", "consegue", "conseguem", "conseguir", "parece", "parecem", "fica", "ficam", "passa",
  "passam", "passar", "passou", "volta", "voltam", "chega", "chegam", "funciona", "funcionam",
  "funcionou", "falha", "falham", "falhou", "falhar", "usa", "usam", "usar", "mete", "metem",
  "tira", "tiram", "guarda", "guardam", "guardar", "procura", "procuram", "procurar", "encontra",
  "encontram", "encontrar", "escreve", "escrevem", "escrever", "escrito", "corre", "correm",
  "correu", "correr", "segue", "seguem", "seguir", "continua", "continuam", "comeca", "termina",
  "terminam", "terminou", "verifica", "verificam", "confirma", "confirmam", "concluir", "evita",
  "evitam", "permite", "permitem", "utiliza", "utilizam", "utilizar", "utilizador", "utilizadores",
  "carrega", "carregam", "carregar", "obter", "devolve", "retorna", "retornam", "chama", "chamam",
  "recebe", "recebem", "envia", "enviam", "responde", "respondem", "pergunta", "perguntam",
  "explica", "explicam", "explicar", "acabar", "acabou", "tentou", "conseguiu", "existe",
  "existem", "contem", "contém", "inclui", "incluem", "adicionar", "criar", "apagar", "abrir",
  "fechar", "mudar", "meter", "tirar", "ler", "ouvir", "dizer", "falar", "pedir", "achar",
  "acho", "pensar", "saber", "sei", "querer", "gosta", "gosto", "deve", "basta", "falta",
  "vale", "dar", "ver", "refere", "sou", "somos", "era", "eram", "foram", "serao", "terao",
  "irao", "vao", "vai", "estar", "tiver", "houver", "puder", "quiser", "fizer", "dito",
  "lido", "visto", "posto", "estado", "sendo", "seja", "esteja", "tenha", "haja", "problema",
  "problemas", "linha", "linhas", "pasta", "pastas", "forma", "formas", "maneira", "maneiras",
  "parte", "partes", "coisa", "coisas", "vez", "vezes", "inicio", "ecra", "ecrã", "fixe",
  "tecla", "teclas", "rato", "janela", "janelas", "separador", "separadores", "versao", "versão",
  "versoes", "funcao", "função", "funcoes", "variavel", "variáveis", "variaveis", "cadeia",
  "cadeias", "caractere", "caracteres", "caracter", "caracteres", "inteiro", "inteiros", "nulo",
  "nulos", "verdadeiro", "falso", "vazio", "enquanto", "exemplo", "caso", "casos", "geral",
  "gerais", "jeito", "talvez", "agora", "apenas", "sempre", "nunca", "pois", "assim", "tanto",
  "pouco", "entretanto", "portanto", "contudo", "todavia", "senao", "senão", "aliás", "direto",
  "exatamente", "realmente", "atualmente", "geralmente", "normalmente", "possivel", "possível",
  "necessario", "necessário", "importante", "diferente", "igual", "iguais", "proprio", "próprio",
  "propria", "própria", "mesmo", "mesmos", "mesma", "mesmas", "cada", "ambos", "outro", "outros",
  "outra", "outras", "alguem", "alguém", "ninguem", "ninguém", "algo", "nada", "tudo", "todos",
  "todas", "nenhum", "nenhuma", "qualquer", "qual", "quais", "primeiro", "ultimo", "último",
  "segundo", "proximo", "próximo", "anterior", "seguinte", "seguintes", "acima", "abaixo",
  "dentro", "fora", "perto", "longe", "cedo", "tarde", "hoje", "ontem", "amanhã", "amanha",
  "ainda", "bastante", "demasiado", "quase", "somente", "sobretudo", "principalmente",
  "especialmente", "sobre", "entre", "dois", "duas", "mais", "comigo", "contigo", "connosco",
  "consigo", "mim", "lhe", "lhes", "clica", "clique", "principal", "bora", "epá", "sou",
  "português", "portugues", "inglês", "ingles", "fixe",
]);

const FR_WORDS = new Set([
  "le", "la", "les", "un", "une", "des", "est", "et", "en", "vous", "nous", "avec", "pour",
  "dans", "sur", "pas", "qui", "je", "tu", "il", "elle", "sont", "être", "etre", "avoir",
  "faire", "peut", "tout", "bien", "très", "tres", "aussi", "oui", "non", "bonjour", "merci",
  "au", "aux", "du", "ce", "cette", "ces", "mais", "donc", "car", "ne", "plus", "sans",
  "sous", "entre", "comme", "votre", "notre", "leur", "mon", "ton", "son", "ils", "elles",
  "voilà", "voila", "alors", "toujours", "jamais", "encore", "déjà", "deja", "quelque",
  "chose", "fait", "faites", "voulez", "peux", "dois", "voici", "d'accord", "c'est", "qu'il",
  "ça", "celui", "celle", "ceux", "celles", "chaque", "souvent", "maintenant", "quel",
  "quels", "quelle", "quelles", "combien", "pourquoi", "parce", "lorsque", "puisque",
  "cependant", "toutefois", "chez", "jusqu", "quoi", "dit", "voir", "sais", "sait",
  "savoir", "pouvoir", "vouloir", "faut", "aller", "allez", "allons", "vont", "venir",
  "viens", "prendre", "mettre", "connais", "pense", "parle", "marche", "deux", "trois",
  "premier", "dernier", "nouveau", "petit", "gros", "bon", "mauvais", "français", "francais",
  "ceci", "cela", "où", "avez",
]);

export type DetectedLanguage = "pt" | "en" | "fr";

/** Which language does this text look like? Inconclusive defaults to English. */
export function detectLanguage(text: string): DetectedLanguage {
  const lower = text.toLowerCase();
  const words = lower.match(/[a-zà-ÿ']+/g) ?? [];
  let pt = 0;
  let en = 0;
  let fr = 0;
  for (const word of words) {
    if (PT_WORDS.has(word)) pt++;
    if (EN_WORDS.has(word)) en++;
    if (FR_WORDS.has(word)) fr++;
  }
  // Distinctive letters. ã/õ are Portuguese; é/ê/à/ç also occur in French,
  // so only the Portuguese-leaning accents count here.
  if (/[ãõ]/.test(lower)) pt += 2;
  if (/[œëï]/.test(lower)) fr += 2;
  if (/[áíóúâ]/.test(lower)) pt += 1;

  if (fr > pt && fr >= en) return "fr";
  if (en > pt && en >= fr) return "en";
  if (pt > en && pt > fr) return "pt";
  return "en"; // inconclusive: English is the default
}
