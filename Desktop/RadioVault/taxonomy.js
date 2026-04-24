'use strict';
/**
 * taxonomy.js -- Configurable keyword taxonomy for RadioVault
 *
 * Default taxonomy is radio broadcast focused; editable via settings UI.
 */

const DEFAULT_TAXONOMY = {
  broadcast: [
    "tiger network", "pregame show", "postgame show", "halftime", "halftime show",
    "kickoff", "opening drive", "broadcast", "on the air", "radio",
  ],
  play_by_play: [
    "touchdown", "field goal", "interception", "fumble", "sack", "first down",
    "scoring play", "two minute warning", "overtime", "final score",
    "extra point", "two point conversion", "punt", "kickoff return",
    "three and out", "fourth down", "red zone", "goal line",
    "pass complete", "incomplete", "penalty", "flag on the play",
  ],
  commentary: [
    "play by play", "color commentary", "sideline report", "call of the game",
    "game of the week", "player of the game", "key play", "turning point",
    "momentum shift", "big play",
  ],
  interviews: [
    "coach interview", "player interview", "press conference", "postgame interview",
    "pregame interview", "head coach", "offensive coordinator", "defensive coordinator",
    "special teams", "position coach", "athletic director",
  ],
  analysis: [
    "game preview", "game recap", "injury report", "depth chart", "matchup",
    "key players", "turning point", "momentum", "season outlook",
    "conference standings", "rankings", "bowl game", "playoff",
  ],
  athletics: [
    "clemson", "tigers", "death valley", "memorial stadium", "acc",
    "recruiting", "transfer portal", "nil", "signing day",
    "spring practice", "fall camp",
  ],
};

/**
 * Load taxonomy from settings, falling back to defaults.
 * @param {object} [settings] - The app settings object
 * @returns {object} taxonomy map { category: [keywords] }
 */
function loadTaxonomy(settings) {
  if (settings?.taxonomy && typeof settings.taxonomy === 'object') {
    const custom = settings.taxonomy;
    return { ...DEFAULT_TAXONOMY, ...custom };
  }
  return { ...DEFAULT_TAXONOMY };
}

/**
 * Flatten taxonomy into a list of { keyword, category } for clip extraction.
 * @param {object} taxonomy
 * @returns {Array<{ keyword: string, category: string }>}
 */
function flattenTaxonomy(taxonomy) {
  const result = [];
  for (const [category, keywords] of Object.entries(taxonomy)) {
    for (const keyword of keywords) {
      result.push({ keyword, category });
    }
  }
  return result;
}

module.exports = { DEFAULT_TAXONOMY, loadTaxonomy, flattenTaxonomy };
