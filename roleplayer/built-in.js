"use strict";
/* The text the program writes itself, apart from the main system prompt (its prompts, stand-in words and help screen):
   what each piece is for and its original wording.
   The wording in use is kept in the settings (builtIn, standIn and safety), where the admin page and the installer editor can change it.
   Used by the program and by the installer editor. */
(function (api) {
  if (typeof module === "object") module.exports = api; else globalThis.BuiltIn = api;
})((() => {
  const PROMPTS = {
    director: { title: "Director: instructions", note: "Sent as the system prompt to choose who speaks next and to whom, when a roleplay has more than one character and the user has not named exactly one of them. The program reads the answer as JSON with \"next\" and \"to\", so keep that part. Tags: [CHARACTERS] [NEXT].",
      text: "You direct a group roleplay. Decide who speaks next and who they speak to.\nCharacters who may speak now: [CHARACTERS].\nThe human is \"user\" and is the main participant.\nGuidelines:\n- \"next\" is [NEXT].\n- \"to\" is usually \"user\". Choose another character only when it is clearly natural for \"next\" to say something to them - about one time in four. That character then answers.\nAnswer with JSON only: {\"next\":\"<character name>\",\"to\":\"<user or character name>\"}" },
    directorFree: { title: "Director: [NEXT] when any free character may speak", note: "Placed in the director's instructions. No tags.",
      text: "whoever the user addressed or asked, otherwise whoever fits the topic best. Do not let one character dominate" },
    directorAnswering: { title: "Director: [NEXT] when a character has just been spoken to", note: "Placed in the director's instructions. Tags: [NAME].",
      text: "[NAME], who has just been spoken to" },
    directorReacting: { title: "Director: [NEXT] when a character has just spoken to the user", note: "Placed in the director's instructions, to choose whether another character, who has not spoken since the user, reacts as well. \"user\" hands the turn back to the user. No tags.",
      text: "a character who would naturally react to what was just said, or \"user\" when no one would. Usually \"user\": choose a character about one time in three" },
    directorGiven: { title: "Director: what it is given", note: "Sent as the user message with the director's instructions. The conversation is the last 10 lines, each cut to 400 characters. Tags: [SCENARIO] [CONVERSATION].",
      text: "Scenario: [SCENARIO]\n\nRecent conversation:\n[CONVERSATION]" },
    memory: { title: "Memory about the user: instructions", note: "Sent as the system prompt once the characters have replied to every third message from the user, when memory is switched on. The program reads the answer as JSON with \"facts\", each with \"text\" and \"kind\", so keep that part. No tags.",
      text: "You keep notes about the person taking part in a roleplay. From their recent messages, extract lasting facts about the real person: who they are, what they like or dislike, personality traits, and what they are aiming for. Ignore everything that is only true of the pretend scene or of the part they are playing in it (for example an order in a cafe, or a quest their character is on). Only include facts that are NOT already known. Maximum 3. Answer with JSON only: {\"facts\":[{\"text\":\"short third-person fact\",\"kind\":\"About you|Likes|Dislikes|Personality|Goals\"}]}. Use an empty list if there is nothing new." },
    memoryGiven: { title: "Memory about the user: what it is given", note: "Sent as the user message with the memory instructions. The messages are the user's last 6. Tags: [SCENARIO] [KNOWN] [MESSAGES].",
      text: "Scene: [SCENARIO]\n\nAlready known:\n[KNOWN]\n\nRecent messages from the person:\n[MESSAGES]" },
    summary: { title: "Summary of the story so far: instructions", note: "Sent as the system prompt when the conversation is filling the roleplay's memory size. No tags.",
      text: "You keep the memory of a roleplay. You are given the summary so far and the new lines of the conversation. Write one new summary that merges both. Write it in your own words, as plain prose in the third person and the past tense. Never copy lines and never write dialogue. Keep, in order, what has happened. Small details matter most: always keep every name, age, pet, relative, job, promise, decision and password, and everything a character or the user has said about themselves, even when it was mentioned only once. When space is short, cut descriptions of scenery and mood first. At most 200 words. Answer with the summary only." },
    summaryGiven: { title: "Summary of the story so far: what it is given", note: "Sent as the user message with the summary instructions. Tags: [SUMMARY] [LINES].",
      text: "Summary so far:\n[SUMMARY]\n\nNew lines:\n[LINES]\n\nNow write the new summary, in your own words." },
    story: { title: "Character: the summary", note: "Sent to a character before the conversation, when older lines no longer fit. Tags: [SUMMARY].",
      text: "(The story so far: [SUMMARY])" },
    cueOpen: { title: "Character: cue to open the scene", note: "The last thing sent to the character who speaks first. Tags: [NAME].",
      text: "(The scene begins. Open the conversation as [NAME], speaking to the user.)" },
    cueLast: { title: "Character: cue to speak to the user", note: "The last thing sent to a character who speaks to the user. Tags: [NAME] [ANSWERING].",
      text: "([NAME], it is your turn.[ANSWERING] Speak to the user. Bring something new to the scene; do not repeat an earlier question.)" },
    cueOther: { title: "Character: cue to speak to another character", note: "The last thing sent to a character who speaks to another character. Tags: [NAME] [ANSWERING] [TO].",
      text: "([NAME], it is your turn.[ANSWERING] Speak to [TO].)" },
    sounds: { title: "Character: sounds for an expressive voice", note: "Added to the main system prompt for a character who speaks with one of the expressive voices, while the voice is switched on. The sounds are heard and not shown. Tags: [SOUNDS].",
      text: "You can let feeling be heard in your voice. Where it happens in what you say, put one of these sounds, written exactly like this: [SOUNDS]. Use at most one or two in a reply, and only where it is natural." },
    tone: { title: "Roleplay: tone of language", note: "Added after the main system prompt, and after what is added for the character, when the roleplay is given a tone of language. Tags: [TONE].",
      text: "The tone of language in this roleplay, in what is said and in the narration: [TONE]. Keep to it, while each character keeps their own personality and way of speaking." },
    speech: { title: "Character: how they speak", note: "Added after the main system prompt when a character's speech style is filled in. Tags: [NAME] [SPEECH].",
      text: "How [NAME] speaks: [SPEECH]" },
    relationship: { title: "Character: relationship with the user", note: "Added after the main system prompt when a character's relationship with the user is filled in. Tags: [NAME] [RELATIONSHIP].",
      text: "[NAME]'s relationship with the user: [RELATIONSHIP]" },
    goals: { title: "Character: what they want", note: "Added after the main system prompt when what a character wants is filled in. Tags: [NAME] [GOALS].",
      text: "What [NAME] wants in this story: [GOALS]" },
    examples: { title: "Character: example lines", note: "Added after the main system prompt when a character has example lines. Tags: [NAME] [EXAMPLES].",
      text: "Examples of how [NAME] talks. Match this voice and style, but never repeat these lines:\n[EXAMPLES]" },
    planner: { title: "Planner: instructions", note: "Sent as the system prompt to plan a character's next reply, when the roleplay is set to plan its replies. The plan is written in JSON and given to the character with the plan cue. Tags: [NAME] [TO].",
      text: "You plan the next reply in a roleplay. You never write the reply itself. Decide what [NAME] says and does in their next reply, to [TO], so that the story moves forward: something is revealed, decided, done or changed. Every beat is something that happens in this reply, not something intended or about to happen. Answer only in JSON, with two to four beats: {\"tone\": \"...\", \"beats\": [{\"kind\": \"says\" or \"does\", \"text\": \"...\"}], \"ends_on\": \"...\"}" },
    plannerGiven: { title: "Planner: what it is given", note: "Sent as the user message with the planner's instructions. The conversation is the last 10 lines, each cut to 400 characters. Tags: [NAME] [TO] [PERSONALITY] [SCENARIO] [CONVERSATION].",
      text: "Scenario: [SCENARIO]\n[NAME]: [PERSONALITY]\n\nRecent conversation:\n[CONVERSATION]\n\nPlan [NAME]'s next reply, to [TO]." },
    plan: { title: "Character: the plan cue", note: "Added to the cue when a reply has been planned. Tags: [PLAN].",
      text: "(The plan for this reply. Follow it, in your own words, without mentioning it:\n[PLAN])" },
    retryCharacter: { title: "Retry: out of character", note: "Added to the cue when the user retries a reply for this reason. Tags: [NAME] [WORDS].",
      text: "(Your last attempt at this reply was out of character. Stay true to [NAME]'s personality, voice and knowledge.)" },
    retryRepeat: { title: "Retry: too repetitive", note: "Added to the cue when the user retries a reply for this reason. Tags: [NAME] [WORDS].",
      text: "(Your last attempt at this reply repeated what has already been said. Say something new, in different words.)" },
    retryIncoherent: { title: "Retry: incoherent", note: "Added to the cue when the user retries a reply for this reason. Tags: [NAME] [WORDS].",
      text: "(Your last attempt at this reply did not make sense. Write clear, complete sentences that follow from what has just happened.)" },
    retryForUser: { title: "Retry: spoke or acted for the user", note: "Added to the cue when the user retries a reply for this reason. Tags: [NAME] [WORDS].",
      text: "(Your last attempt at this reply spoke or acted for the user. Write only [NAME]'s own words; never decide what the user says, does or feels.)" },
    retryAnnounced: { title: "Retry: announced instead of acting", note: "Added to the cue when the user retries a reply for this reason. Tags: [NAME] [WORDS].",
      text: "(Your last attempt at this reply said what [NAME] was going to do instead of doing it. Do it now, and speak as it happens or is done.)" },
    retryLong: { title: "Retry: too long", note: "Added to the cue when the user retries a reply for this reason. Tags: [NAME] [WORDS].",
      text: "(Your last attempt at this reply was too long. Keep it to about [WORDS] words.)" },
    retryShort: { title: "Retry: too short", note: "Added to the cue when the user retries a reply for this reason. Tags: [NAME] [WORDS].",
      text: "(Your last attempt at this reply was too short. Make it about [WORDS] words long.)" },
    cueAnswering: { title: "Character: [ANSWERING] in a cue", note: "Placed in a cue, after a space, when the previous line was spoken to this character. Otherwise [ANSWERING] is empty. Tags: [OTHER].",
      text: "[OTHER] has just spoken to you: answer briefly." }
  };
  /* What is written where something has not been filled in, and the names given to speakers in a conversation sent to the AI: key, use, original words. */
  const STAND_INS = [
    ["trait", "[PERSONALITY] or [INTERESTS] is empty", "not specified"],
    ["scenario", "[SCENARIO] is empty, in the main system prompt", "An open, friendly conversation."],
    ["scene", "The scenario is empty, for the director and the memory", "open conversation"],
    ["others", "[OTHER_CHARACTERS], when there are none", "none"],
    ["user", "[USER_NAME], [USER_AGE] or [USER_GENDER] is empty", "not given"],
    ["facts", "[USER_FACTS], when nothing is known", "nothing yet"],
    ["interests", "Start of the [USER_FACTS] line that lists the user's interests", "- Interested in: "],
    ["description", "A character without a personality, for the director", "no description"],
    ["summary", "No summary yet, for the summary", "(nothing yet)"],
    ["known", "Nothing known yet, for the memory", "(nothing)"],
    ["narrator", "How the narration sounds, when it is read by the described voice and no description is written", "storyteller, calm and clear, moderate pace"],
    ["userLabel", "Name given to the user's lines", "User"],
    ["unknown", "Name given to the lines of a character who was deleted", "Someone"]
  ];
  /* The words of the help screen, shown when the safety check finds signs of suicide or self-harm: key, use, original words. */
  const SAFETY_TEXTS = [
    ["heading", "Heading", "You don't have to face this alone"],
    ["fromUser", "When something the user wrote was flagged", "The roleplay has been paused. Something you wrote sounded like you might be thinking about suicide or harming yourself. If that is how you feel, please talk to someone now. It is free and confidential."],
    ["fromCharacter", "When a character's reply was flagged", "The roleplay has been paused, and a reply that touched on suicide or self-harm has been removed. If any of it is on your mind, please talk to someone now. It is free and confidential."],
    ["emergency", "The emergency line. Tags: [NUMBER], the emergency number of the user's country", "If you are in danger right now, call [NUMBER]."],
    ["noCountry", "The emergency line, when the user's country has no helpline listed", "If you are in danger right now, call your local emergency number."],
    ["elsewhere", "Before the website that lists the helplines of every country", "Helplines in every country:"],
    ["call", "Before the helpline's number to call", "Call"],
    ["textTo", "Before the helpline's number to text", "Text"],
    ["allHours", "When the helpline is open at all hours", "Open day and night"],
    ["someHours", "When the helpline is not open at all hours", "Not open at all hours"],
    ["carryOn", "The button that goes back to the roleplay", "This was part of the story, carry on"],
    ["close", "The button that closes the help screen, leaving the roleplay paused", "Close"]
  ];
  /* The models offered for download in each size, by their names in the Ollama library or on Hugging Face (hf.co/...).
     The first of a size is the recommended one. added: the version of this list a model joined it in, when after the
     first; a settings file that has not seen that version is given the model (see complete). */
  const MODELS_VERSION = 2;
  const MODELS = {
    small: [
      { name: "hf.co/mradermacher/L3-8B-Lunaris-v1-i1-GGUF:Q4_K_M", note: "4.9 GB. Trained for roleplay and storytelling. Built with Meta Llama 3.", added: 2 },
      { name: "huihui_ai/qwen3-abliterated:4b", note: "2.5 GB. Keeps to the length of reply you ask for; the best all-rounder at this size." },
      { name: "huihui_ai/qwen3-abliterated:4b-instruct-2507-q4_K_M", note: "2.5 GB. A newer version that tells longer stories, but often runs past the length you ask for." }
    ],
    medium: [
      { name: "hf.co/bartowski/Pantheon-RP-1.6.1-12b-Nemo-GGUF:IQ4_XS", note: "6.7 GB. Trained for roleplay. Fits entirely on a graphics card with 8 GB.", added: 2 },
      { name: "hf.co/bartowski/PocketDoc_Dans-PersonalityEngine-V1.3.0-12b-GGUF:IQ4_XS", note: "6.7 GB. Trained for roleplay and creative writing. Fits entirely on a graphics card with 8 GB.", added: 2 },
      { name: "huihui_ai/gemma-4-abliterated:12b", note: "7.6 GB. Characterful, and keeps to the length of reply you ask for." },
      { name: "HammerAI/mn-mag-mell-r1:12b-q4_K_M", note: "7.5 GB. The most vivid storytelling; its replies run long." }
    ],
    large: [
      { name: "hf.co/bartowski/Gryphe_Pantheon-RP-1.8-24b-Small-3.1-GGUF:Q4_K_M", note: "14.3 GB. Trained for roleplay; for a graphics card with 16 GB or more.", added: 2 },
      { name: "hf.co/bartowski/PocketDoc_Dans-PersonalityEngine-V1.3.0-24b-GGUF:Q4_K_M", note: "14.3 GB. Trained for roleplay and creative writing; for a graphics card with 16 GB or more.", added: 2 },
      { name: "huihui_ai/mistral-small-abliterated", note: "14.3 GB. Dependable; for a graphics card with 16 GB or more." },
      { name: "huihui_ai/gemma-4-abliterated:31b-v2-q4_K", note: "19.9 GB. The most capable; needs a graphics card with 24 GB." }
    ]
  };
  const HELPER = "huihui_ai/qwen3-abliterated:4b";   // the small model that writes the summary and the notes about the user
  const EXPRESSIVE = "legraphista/Orpheus";          // the speech model behind the expressive voices, run by the AI engine
  const REPEAT_PENALTY = 1.15;                         // how strongly a character is kept from reusing its own wording; 1 is off
  /* The original wording of every built-in text. */
  const factory = () => ({
    builtIn: Object.fromEntries(Object.entries(PROMPTS).map(([key, prompt]) => [key, prompt.text])),
    standIn: Object.fromEntries(STAND_INS.map(([key, , words]) => [key, words])),
    safety: Object.fromEntries(SAFETY_TEXTS.map(([key, , words]) => [key, words]))
  });
  /* The models of one size as a settings file gives them. A file from before there was a choice names one model, which
     becomes the second choice. Models added to the built-in list since the file last saw it (seen: the version) are
     put in, before the rest; one renamed in admin after that is not given back. The model recommended for the size comes
     first whenever it is among them. */
  function offered(size, given, seen) {
    const plain = ({ name, note }) => ({ name, note }), [recommended] = MODELS[size], fresh = () => MODELS[size].map(plain);
    const listed = Array.isArray(given) && given.length && given.every(model => model && typeof model.name === "string");
    // Models added to the list since the settings were last completed are offered too, before the others.
    const joined = MODELS[size].filter(model => (model.added || 1) > seen && !(listed ? given : []).some(other => other.name === model.name)).map(plain);
    const models = listed ? [...joined, ...given] : typeof given === "string" && given !== recommended.name ? [plain(recommended), ...joined.filter(model => model.name !== recommended.name), { name: given, note: "" }] : fresh();
    const place = models.findIndex(model => model.name === recommended.name);
    return place > 0 ? [models[place], ...models.filter((_, at) => at !== place)] : models;
  }
  /* The texts a settings file gives, for the keys still in use; the rest in their original wording. */
  const kept = (original, given = {}) => Object.fromEntries(Object.entries(original).map(([key, text]) => [key, typeof given[key] === "string" ? given[key] : text]));
  const complete = cfg => {
    const original = factory();
    return {
      ...cfg,
      models: { ...Object.fromEntries(Object.keys(MODELS).map(size => [size, offered(size, cfg.models?.[size], cfg.modelsVersion ?? 1)])), expressive: cfg.models?.expressive ?? EXPRESSIVE },
      modelsVersion: MODELS_VERSION,
      repeatPenalty: cfg.repeatPenalty ?? REPEAT_PENALTY,
      builtIn: kept(original.builtIn, cfg.builtIn),
      standIn: kept(original.standIn, cfg.standIn),
      safety: kept(original.safety, cfg.safety)
    };
  };
  /* The models that are part of the AI engine, set up with it: no roleplay runs without them. */
  const ENGINE_MODELS = [HELPER];
  return { PROMPTS, STAND_INS, SAFETY_TEXTS, HELPER, ENGINE_MODELS, factory, complete };
})());
