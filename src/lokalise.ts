import { parse } from "@formatjs/icu-messageformat-parser";
import { LokaliseApi } from "@lokalise/node-api";
import AdmZip from "adm-zip";
import assert from "node:assert";
import chalk from "chalk";
import { Command } from "commander";
import fs from "node:fs";
import { globSync } from "glob";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { isMatching, P } from "ts-pattern";

assert(process.env.LOKALISE_API_KEY != null, "Missing LOKALISE_API_KEY");

const program = new Command();

const lokaliseApi = new LokaliseApi({
  apiKey: process.env.LOKALISE_API_KEY,
});

type Project = {
  name: string;
  id: string;
  defaultLocale: string;
  paths: {
    src: string;
    locales: string;
  };
};

const { default: projects } = await import(
  path.join(process.cwd(), "lokalise.config.js")
);

const isConfigurationCorrect = isMatching(
  P.array({
    name: P.string,
    id: P.string,
    defaultLocale: P.string,
    paths: {
      src: P.string,
      locales: P.string,
    },
  })
);

if (!isConfigurationCorrect(projects)) {
  console.error("Invalid configuration");
  process.exit(1);
}

const preventRateLimiting = () =>
  new Promise((resolve) => {
    setTimeout(() => resolve(undefined), 1000);
  });

const tmpDir = os.tmpdir();

const TAB_REGEX = /\t+/g;
const LEADING_SPACE_REGEX = /^\s+/g;
const TRAILING_SPACE_REGEX = /\s+$/g;

// Sort keys and fix what we can
const cleanupJson = (
  json: Record<string, string>,
  allowedKeys: Set<string>
) => {
  const keys = Object.keys(json);

  keys.sort();

  return keys.reduce((acc, key) => {
    // Key has been removed from the reference locale, remove it
    if (!allowedKeys.has(key)) {
      return acc;
    }
    let value = json[key] as string;
    // Replace tabs with a single space
    if (value.includes("\t")) {
      value = value.replace(TAB_REGEX, " ");
    }
    // Trim spaces left
    if (value.startsWith(" ")) {
      value = value.replace(LEADING_SPACE_REGEX, "");
    }
    // Trim spaces right
    if (value.endsWith(" ")) {
      value = value.replace(TRAILING_SPACE_REGEX, "");
    }
    return { ...acc, [key]: value };
  }, {});
};

// Tries to parse the ICU message to check for errors
const lintLocalesFile = (json: Record<string, string>) => {
  const errors: { key: string; error: unknown }[] = [];
  Object.entries(json).forEach(([key, value]) => {
    try {
      parse(value);
    } catch (error) {
      errors.push({ key, error });
    }
  });
  return errors.length === 0 ? null : errors;
};

async function pullProject(project: Project) {
  // We only write english translations manually:
  // this is our source of truth for new translations
  const localTranslations = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "packages", project.name, "src/locales/en.json"),
      "utf-8"
    )
  );

  // Grab the latest translations from lokalise
  const { bundle_url: bundleUrl } = await lokaliseApi
    .files()
    .download(project.id, {
      // https://app.lokalise.com/api2docs/curl/#transition-download-files-post
      bundle_structure: "%LANG_ISO%.%FORMAT%",
      disable_references: true,
      export_empty_as: "skip",
      format: "json",
      icu_numeric: true,
      indentation: "2sp",
      json_unescaped_slashes: true,
      original_filenames: false,
      placeholder_format: "icu",
      plural_format: "icu",
      replace_breaks: false,
    });

  const zipFilePath: string = await new Promise((resolve, reject) => {
    const filePath = path.join(tmpDir, `${project.name}.zip`);
    const writeStream = fs.createWriteStream(filePath);
    writeStream.on("close", () => resolve(filePath));
    writeStream.on("error", reject);
    https.get(bundleUrl, (res) => res.pipe(writeStream));
  });

  await preventRateLimiting();

  const zip = new AdmZip(zipFilePath);
  const pulledLocales = zip
    .getEntries()
    .reduce<Record<string, Record<string, string>>>((acc, entry) => {
      if (entry.isDirectory) {
        return acc;
      }
      const content = entry.getData().toString("utf-8");
      acc[path.basename(entry.entryName, ".json")] = JSON.parse(content);
      return acc;
    }, {});

  const localKeys = new Set<string>();
  Object.keys(localTranslations).forEach((key) => localKeys.add(key));

  const pulledKeys = new Set<string>();
  const pulledDefaultLocale = pulledLocales[project.defaultLocale];

  if (pulledDefaultLocale == null) {
    console.error(
      `${project.name} is missing translations for its default locale`
    );
    return;
  }

  Object.keys(pulledDefaultLocale).forEach((key) => pulledKeys.add(key));

  const locallyAddedKeys = Object.keys(localTranslations).filter(
    (key) => !pulledKeys.has(key)
  );
  const locallyRemovedKeys = [...pulledKeys].filter(
    (key) => !localKeys.has(key)
  );

  // Newly added keys will only happen in the reference version (ie. english)
  // Keep newly added keys, so that we can push them
  locallyAddedKeys.forEach((key) => {
    pulledDefaultLocale[key] = localTranslations[key];
  });

  // Remove unused keys from everywhere
  locallyRemovedKeys.forEach((key) => {
    Object.values(pulledLocales).forEach((json) => {
      delete json[key];
    });
  });

  // Write translation files
  Object.entries(pulledLocales).forEach(([localeName, json]) => {
    const filePath = path.join(
      process.cwd(),
      "packages",
      project.name,
      "src/locales/",
      `${localeName}.json`
    );
    const displayFilePath = path.relative(process.cwd(), filePath);
    console.log(`${displayFilePath} ${chalk.green("pulled")}`);

    fs.writeFileSync(filePath, JSON.stringify(json, null, 2) + os.EOL, "utf-8");
  });

  console.log("");

  cleanupProject(project);

  console.log("");

  if (!lintProject(project)) {
    process.exit(1);
  }
}

async function syncProject(project: Project) {
  await pullProject(project);

  pushProject(project);
}

const pushProject = async (project: Project) => {
  cleanupProject(project);

  console.log("");

  if (!lintProject(project)) {
    process.exit(1);
  }

  console.log("");

  const localesDir = path.join(
    process.cwd(),
    "packages",
    project.name,
    "src/locales"
  );
  const files = fs
    .readdirSync(localesDir)
    .filter((item) => path.extname(item) === ".json");

  for (const file of files) {
    const localeName = path.basename(file, ".json");
    const filePath = path.join(localesDir, localeName);
    const displayFilePath = path.relative(process.cwd(), filePath);

    const locales = fs.readFileSync(
      path.join(localesDir, localeName + ".json"),
      "utf-8"
    );
    // Upload new keys to Lokalise
    await lokaliseApi.files().upload(project.id, {
      // https://app.lokalise.com/api2docs/curl/#transition-upload-a-file-post
      data: Buffer.from(locales).toString("base64"),
      cleanup_mode: true,
      convert_placeholders: false,
      detect_icu_plurals: false,
      filename: localeName + ".json",
      lang_iso: localeName,
      replace_modified: true,
      skip_detect_lang_iso: true,
      slashn_to_linebreak: true,
    });

    console.log(`${displayFilePath} ${chalk.green("uploaded")}`);

    await preventRateLimiting();
  }
};

const lintProject = (project: Project) => {
  const localesDir = path.join(
    process.cwd(),
    "packages",
    project.name,
    "src/locales"
  );
  let isOk = true;

  fs.readdirSync(localesDir)
    .filter((item) => path.extname(item) === ".json")
    .forEach((locale) => {
      const locales = JSON.parse(
        fs.readFileSync(path.join(localesDir, locale), "utf-8")
      );
      const errors = lintLocalesFile(locales);
      const filePath = path.relative(
        process.cwd(),
        path.join(localesDir, locale)
      );
      if (errors) {
        isOk = false;
        console.log(`${filePath} ${chalk.red("errors")}`);
        errors.forEach(({ key, error }) => {
          console.log(`  ${chalk.yellow(key)}: ${chalk.red(error)}`);
        });
      }
    });
  return isOk;
};

const cleanupProject = (project: Project) => {
  const localesDir = path.join(
    process.cwd(),
    "packages",
    project.name,
    "src/locales"
  );

  const allowedKeys = new Set<string>();
  const referenceJson = JSON.parse(
    fs.readFileSync(path.join(localesDir, "en.json"), "utf-8")
  );
  Object.keys(referenceJson).forEach((key) => allowedKeys.add(key));

  fs.readdirSync(localesDir)
    .filter((item) => path.extname(item) === ".json")
    .forEach((locale) => {
      const filePath = path.join(localesDir, locale);
      const displayFilePath = path.relative(process.cwd(), filePath);

      const rawFile = fs.readFileSync(filePath, "utf-8");
      const json = JSON.parse(rawFile);
      const cleanJson = cleanupJson(json, allowedKeys);
      console.log(`${displayFilePath} ${chalk.green("cleaned")}`);
      const nextRawFile = JSON.stringify(cleanJson, null, 2) + os.EOL;
      if (rawFile !== nextRawFile) {
        fs.writeFileSync(
          filePath,
          JSON.stringify(cleanJson, null, 2) + os.EOL,
          "utf-8"
        );
      }
    });
};

const findUnusedInProject = (project: Project) => {
  const srcDir = path.join(process.cwd(), "packages", project.name, "src");
  const referenceLocalePath = path.join(
    process.cwd(),
    "packages",
    project.name,
    "src/locales/en.json"
  );
  const referenceLocaleDisplayPath = path.relative(
    process.cwd(),
    referenceLocalePath
  );

  const referenceLocales = JSON.parse(
    fs.readFileSync(referenceLocalePath, "utf-8")
  );
  const refrenceKeys = Object.keys(referenceLocales);

  const code = globSync(path.join(srcDir, "**", "*.{ts,tsx}")).reduce(
    (acc, file) => acc + fs.readFileSync(file, "utf-8") + os.EOL,
    ""
  );

  const unusedKeys = refrenceKeys.filter((key) => {
    // when the last part is variable
    const variantKey1 = key.split(".").slice(0, -1).join(".") + ".${";
    // when the 2 last parts are variable
    const variantKey2 = key.split(".").slice(0, -2).join(".") + ".${";

    return (
      !code.includes(`"${key}"`) &&
      !code.includes(`\`${key}\``) &&
      !code.includes(`'${key}'`) &&
      !code.includes(`\`${variantKey1}`) &&
      !code.includes(`\`${variantKey2}`)
    );
  });

  if (unusedKeys.length > 0) {
    console.log(
      `${chalk.blue(project.name)}: ${chalk.red(
        `${unusedKeys.length} unused key${unusedKeys.length !== 1 ? "s" : ""}`
      )}`
    );
    console.log(`${chalk.grey(referenceLocaleDisplayPath)}`);
    unusedKeys.forEach((key) => {
      console.log(`  ${chalk.yellow(key)}`);
    });
  } else {
    console.log(
      `${chalk.blue(project.name)}: ${chalk.green("no unused keys")}`
    );
  }

  return {
    keptKeys: new Set(
      refrenceKeys.filter((item) => !unusedKeys.includes(item))
    ),
    unusedKeys,
  };
};

const onlyKeepKeysInJson = (jsonFilePath: string, keysToKeep: Set<string>) => {
  const json = JSON.parse(fs.readFileSync(jsonFilePath, "utf-8"));

  const jsonWithoutKeys = Object.keys(json).reduce<Record<string, string>>(
    (acc, key) => {
      if (keysToKeep.has(key)) {
        acc[key] = json[key];
      }
      return acc;
    },
    {}
  );

  fs.writeFileSync(
    jsonFilePath,
    JSON.stringify(jsonWithoutKeys, null, 2) + os.EOL,
    "utf-8"
  );

  console.log(
    `${chalk.grey(path.relative(process.cwd(), jsonFilePath))} ${chalk.green(
      "cleaned"
    )}`
  );
};

const findAndRemoveUnusedInProject = (project: Project) => {
  const srcDir = path.join(process.cwd(), "packages", project.name, "src");
  const { keptKeys } = findUnusedInProject(project);

  const locales = path.join(srcDir, "locales");
  const localeFiles = globSync(path.join(locales, "*.json"));

  for (const localeFile of localeFiles) {
    onlyKeepKeysInJson(localeFile, keptKeys);
  }
};

program
  .command("sync")
  .description("Sync translations with lokalise")
  .action(async () => {
    for (const project of projects) {
      console.log(chalk.blue(project.name));
      console.log(chalk.gray("---"));
      await syncProject(project);
      console.log("");
      console.log("");
    }
  });

program
  .command("pull")
  .description("Pull translations from lokalise")
  .action(async () => {
    for (const project of projects) {
      console.log(chalk.blue(project.name));
      console.log(chalk.gray("---"));
      await pullProject(project);
      console.log("");
      console.log("");
    }
  });

program
  .command("push")
  .description("Push translations to lokalise")
  .action(async () => {
    for (const project of projects) {
      console.log(chalk.blue(project.name));
      console.log(chalk.gray("---"));
      await pushProject(project);
      console.log("");
      console.log("");
    }
  });

program
  .command("clean")
  .description("Clean translations")
  .action(async () => {
    for (const project of projects) {
      console.log(chalk.blue(project.name));
      console.log(chalk.gray("---"));
      cleanupProject(project);
      console.log("");
      console.log("");
    }
  });

program
  .command("lint")
  .description("Lint translations")
  .action(async () => {
    let hasError = false;
    for (const project of projects) {
      if (!lintProject(project)) {
        hasError = true;
        console.log("");
        console.log("");
      }
    }
    if (hasError) {
      process.exit(1);
    }
  });

program
  .command("find-unused")
  .description("Find unused translations")
  .action(() => {
    for (const project of projects) {
      findUnusedInProject(project);
      console.log("");
    }
  });

program
  .command("remove-unused")
  .description("Find and remove unused translations")
  .action(() => {
    for (const project of projects) {
      findAndRemoveUnusedInProject(project);
      console.log("");
    }
  });

program.parse(process.argv);
