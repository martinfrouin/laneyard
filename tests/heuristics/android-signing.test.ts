import { describe, expect, it } from "vitest";
import { NO_SIGNING_FACTS, parseAndroidSigning } from "../../src/heuristics/android-signing.js";

/** The snippet the Flutter documentation gives, and therefore the common one. */
const FLUTTER_KTS = `
val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("key.properties")

android {
    signingConfigs {
        create("release") { }
    }
    buildTypes {
        release {
            signingConfig = if (keystorePropertiesFile.exists()) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }
}
`;

describe("parseAndroidSigning", () => {
  it("sees the release build type taking the debug key, and what it hinges on", () => {
    expect(parseAndroidSigning(FLUTTER_KTS)).toEqual({
      releaseCanUseDebugKey: true,
      conditionalOn: { name: "key.properties", scope: "root" },
    });
  });

  // A name is half an answer. `rootProject.file("key.properties")` resolves from
  // the Gradle root and `file("signing.properties")` from the module, and anyone
  // writing the file rather than merely reporting it needs to know which.
  it("tells rootProject scope from module scope", () => {
    const root = parseAndroidSigning(`
      val f = rootProject.file("key.properties")
      android { buildTypes { release { signingConfig = signingConfigs.getByName("debug") } } }
    `);
    expect(root.conditionalOn).toEqual({ name: "key.properties", scope: "root" });

    const module = parseAndroidSigning(`
      val f = file("signing.properties")
      android { buildTypes { release { signingConfig = signingConfigs.debug } } }
    `);
    expect(module.conditionalOn).toEqual({ name: "signing.properties", scope: "module" });
  });

  // The receiver decides the directory, and a receiver this has never heard of
  // decides one it cannot work out. Saying so is what lets the next step ask
  // rather than guess — a wrong path would be a file written where nothing reads
  // it, and a build that still ships the debug key.
  it("admits when the receiver decides a directory it cannot work out", () => {
    const source = `
      val f = keystoreDir.file("key.properties")
      android { buildTypes { release { signingConfig = signingConfigs.debug } } }
    `;
    expect(parseAndroidSigning(source).conditionalOn).toEqual({
      name: "key.properties",
      scope: "unknown",
    });
  });

  it("reads the Groovy spelling too", () => {
    const groovy = `
      android {
        buildTypes {
          release {
            signingConfig signingConfigs.debug
          }
        }
      }
    `;
    expect(parseAndroidSigning(groovy).releaseCanUseDebugKey).toBe(true);
  });

  it("is quiet about a release that only ever uses the release config", () => {
    const good = `
      android {
        buildTypes {
          release {
            signingConfig = signingConfigs.getByName("release")
          }
        }
      }
    `;
    expect(parseAndroidSigning(good)).toEqual(NO_SIGNING_FACTS);
  });

  // The debug build type may of course use the debug key; that is what it is
  // for. Only the release block is read.
  it("does not mistake the debug build type for the release one", () => {
    const source = `
      android {
        buildTypes {
          release {
            signingConfig = signingConfigs.getByName("release")
          }
          debug {
            signingConfig = signingConfigs.getByName("debug")
          }
        }
      }
    `;
    expect(parseAndroidSigning(source).releaseCanUseDebugKey).toBe(false);
  });

  it("counts braces rather than stopping at the first one", () => {
    const nested = `
      android {
        buildTypes {
          release {
            if (someCondition) { proguardFiles("a") }
            signingConfig = signingConfigs.getByName("debug")
          }
        }
      }
    `;
    expect(parseAndroidSigning(nested).releaseCanUseDebugKey).toBe(true);
  });

  it("says nothing at all about a file it does not understand", () => {
    expect(parseAndroidSigning("this is not gradle")).toEqual(NO_SIGNING_FACTS);
    expect(parseAndroidSigning("")).toEqual(NO_SIGNING_FACTS);
  });
});
