import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";

const compatReactHooks = {
  ...reactHooksPlugin,
  rules: Object.fromEntries(
    Object.entries(reactHooksPlugin.rules).map(([name, rule]) => [
      name,
      {
        ...rule,
        create(context) {
          const proxiedContext = new Proxy(context, {
            get(target, prop, receiver) {
              if (prop === 'getSource') {
                return (...args) => target.sourceCode.getText(...args);
              }
              return Reflect.get(target, prop, receiver);
            }
          });
          return rule.create(proxiedContext);
        }
      }
    ])
  )
};

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/build/**", "node_modules/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: {
      react: reactPlugin,
      "react-hooks": compatReactHooks,
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "react-hooks/rules-of-hooks": "error",
    },
    settings: {
      react: {
        version: "detect"
      }
    }
  }
);
