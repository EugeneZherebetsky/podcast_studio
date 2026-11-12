import * as SQLite from "expo-sqlite";
import { vocabularyStore } from "./vocabulary";

let store: ReturnType<typeof vocabularyStore> | undefined;
export function localVocabulary() {
  if (!store) {
    store = SQLite.openDatabaseAsync("local-vocabulary-v1.db").then(vocabularyStore).catch((error: unknown) => {
      store = undefined;
      throw error;
    });
  }
  return store;
}
