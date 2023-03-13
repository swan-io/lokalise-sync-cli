# Lokalise Sync CLI

## Install

```console
$ yarn add @swan-io/lokalize-sync-cli
```

## Getting started

First, provide a `LOKALISE_API_KEY` environment variable, containing your Lokalise API Key.

Create a `lokalise.config.js` file at the root of your project:

```js
module.exports = [
  {
    name: "your-app-name",
    id: "your-app-lokalise-id",
    defaultLocale: "en",
    paths: {
      src: "/your/app/absolute/path",
      locales: "/your/app/locales/absolute/path,
    },
  },
]
```

## Usage

### lokalise sync

```console
$ lokalise sync
```

Syncs your projects (pulls and pushes).

### lokalise pull

```console
$ lokalise pull
```

Pulls up to date translations from lokalise.

### lokalise push

```console
$ lokalise push
```

Pushes translations to lokalise.

### lokalise clean

```console
$ lokalise clean
```

Removes keys that aren't in the reference locale anymore.

### lokalise lint

```console
$ lokalise lint
```

Checks that translations are in the correct format.

### lokalise find-unused

```console
$ lokalise find-unused
```

Logs values that aren't used in your projects.

### lokalise remove-unused

```console
$ lokalise remove-unused
```

Removes values from your translations files if they aren't used in your projects.
