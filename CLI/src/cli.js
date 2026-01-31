const { Command } = require("commander");
const { runInit } = require("./commands/init");
const { runConfigGet, runConfigSummary, runConfigSet } = require("./commands/config");
const { runStatus } = require("./commands/status");
const { runLogin } = require("./commands/login");
const { runLogout } = require("./commands/logout");
const { runReset } = require("./commands/reset");
const { runCapsuleList, runCapsuleUse } = require("./commands/capsule");
const { runContractCommand } = require("./commands/contract");
const { runInviteList, runInviteAction } = require("./commands/invites");
const { runHostedMe, runHostedFaucet } = require("./commands/hosted");
const { runWalletShow, runWalletBalance, runWalletExport } = require("./commands/wallet");
const { runTestTee } = require("./commands/tee");
const { errorMessage } = require("./ui");

const VERSION = "0.1.0";
const program = new Command();
let hasFatalError = false;

const formatError = (error) => {
  if (!error) {
    return "Action failed.";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error.message) {
    return error.message;
  }
  return "Action failed.";
};

process.on("uncaughtException", (error) => {
  hasFatalError = true;
  errorMessage(formatError(error));
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  hasFatalError = true;
  errorMessage(formatError(error));
  process.exit(1);
});

process.on("exit", (code) => {
  if (!hasFatalError && code && code !== 0) {
    errorMessage("Action failed.");
  }
});

program
  .name("nebulon")
  .description("Nebulon CLI")
  .version(VERSION)
  .configureHelp({
    formatHelp: () => {
      return [
        "Nebulon CLI - help",
        "",
        "Options:",
        "  -v, -V, --version         output the version number",
        "",
        "Commands:",
        "  nebulon init               Initializes the Nebulon setup",
        "  nebulon init capsule <name>  Initializes a specific capsule",
        "  nebulon status             Show account summary",
        "  nebulon login              Login in hosted mode",
        "  nebulon logout             Logout of hosted mode",
        "  nebulon reset              Reset the current capsule",
        "  nebulon reset capsules     Reset all capsules",
        "  nebulon capsule list       List capsules",
        "  nebulon capsule use        Switch capsules",
        "  nebulon contract           Contract commands (create, list, show, disputed, <id> ...)",
        "  nebulon contract <id> sync  Sync PER status to on-chain flags",
        "  nebulon contract <id> milestone list  Show milestone status",
        "  nebulon contract <id> milestone <n> status  Show milestone status",
        "  nebulon contract <id> milestone <n> ready  Mark milestone as ready",
        "  nebulon contract <id> milestone <n> confirm  Confirm milestone",
        "  nebulon contract <id> term list  Show deadline/payment terms",
        "  nebulon contract <id> details  Show full contract details",
        "  nebulon contract <id> status  Show contract summary",
        "  nebulon contract <id> isFunded  Show funding status",
        "  nebulon contract <id> whoami  Show your role for this contract",
        "  nebulon contract <id> nowwhat  Show the next expected action",
        "  nebulon contract <id> rate <1-5>  Rate the other party (completed only)",
        "  nebulon invite list         Show pending invites",
        "  nebulon invite list --show-all  Show accepted/canceled history",
        "  nebulon invite list sent    Show sent invites only",
        "  nebulon invite list received  Show received invites only",
        "  nebulon invite <id|idx>     View or respond to an invite",
        "  nebulon address            Show connected wallet address",
        "  nebulon balance            Show SOL + USDC balance",
        "  nebulon wallet export      Export active wallet to C:\\Nebulon\\Wallets",
        "  nebulon config             Show and edit configuration",
        "  nebulon config [key] [value]  Change a configuration value directly",
        "  nebulon test-tee            Validate TEE auth + RPC connectivity",
        "  nebulon whoami             Show hosted profile",
        "  nebulon request-usdc       Request test USDC from backend faucet",
        "  nebulon help               Shows this menu",
      ].join("\n");
    },
  });

program.helpCommand("help");

program
  .command("init")
  .description("Initialize Nebulon CLI")
  .argument("[arg1]", "capsule or keyword")
  .argument("[arg2]", "capsule name")
  .option("--no-banner", "hide the banner")
  .action(async (arg1, arg2, options) => {
    let capsule = null;
    if (arg1 === "capsule") {
      if (!arg2) {
        console.log("Usage: nebulon init capsule <name>");
        return;
      }
      capsule = arg2;
    } else {
      if (arg2) {
        console.log("Usage: nebulon init [capsule] | nebulon init capsule <name>");
        return;
      }
      capsule = arg1 || null;
    }
    await runInit(options, capsule);
  });

program
  .command("status")
  .description("Show account summary")
  .action(async () => {
    await runStatus();
  });

program
  .command("login")
  .description("Login in hosted mode")
  .option("--handle <handle>", "request a Nebulon handle on login")
  .option("--debug", "enable login debug logging")
  .action(async (options) => {
    await runLogin(options);
  });

program
  .command("logout")
  .description("Logout of hosted mode")
  .action(async () => {
    await runLogout();
  });

program
  .command("reset")
  .description("Reset the current capsule")
  .argument("[scope]", "capsules")
  .action(async (scope) => {
    await runReset(scope);
  });

const capsule = program
  .command("capsule")
  .description("Capsule commands");

capsule
  .command("list")
  .description("List capsules")
  .action(async () => {
    runCapsuleList();
  });

capsule
  .command("use")
  .description("Switch capsules")
  .argument("<name>", "capsule name")
  .action(async (name) => {
    runCapsuleUse(name);
  });

program
  .command("contract")
  .description("Contract commands")
  .argument("[target]", "create | list | show | <id|index>")
  .argument("[rest...]", "contract sub-commands")
  .option("--confirm", "skip confirmation prompts")
  .option("--full-fields", "show full list fields without truncation")
  .action(async (target, rest, options) => {
    const args = [];
    if (target) {
      args.push(target);
    }
    if (Array.isArray(rest) && rest.length) {
      args.push(...rest);
    }
    await runContractCommand(args, options);
  })
  .alias("contracts");

const invite = program
  .command("invite")
  .description("Invite commands")
  .argument("[target]", "list | index | contractId")
  .argument("[action]", "accept | deny")
  .option("--show-all", "show accepted/canceled invites too")
  .action(async (target, action, options) => {
    if (!target || target === "list") {
      await runInviteList(action, options);
      return;
    }
    await runInviteAction(target, action);
  });

invite
  .command("list")
  .description("List invites")
  .argument("[filter]", "sent | received")
  .option("--show-all", "show accepted/canceled invites too")
  .action(async (filter, options) => {
    await runInviteList(filter, options);
  });

program
  .command("config")
  .description("Manage config")
  .argument("[key]", "config key")
  .argument("[value]", "config value")
  .action(async (key, value) => {
    if (!key) {
      await runConfigSummary();
      return;
    }
    if (typeof value === "undefined") {
      runConfigGet(key);
      return;
    }
    await runConfigSet(key, value);
  });

program
  .command("whoami")
  .description("Show hosted profile")
  .action(async () => {
    await runHostedMe();
  });

program
  .command("address")
  .description("Show connected wallet address")
  .action(() => {
    runWalletShow();
  });

program
  .command("balance")
  .description("Show SOL + USDC balance")
  .action(async () => {
    await runWalletBalance();
  });

program
  .command("wallet")
  .description("Wallet commands")
  .argument("[action]", "export")
  .action(async (action) => {
    if (action === "export") {
      await runWalletExport();
      return;
    }
    console.log("Usage: nebulon wallet export");
  });

program
  .command("request-usdc")
  .description("Request test USDC from backend faucet")
  .action(async () => {
    await runHostedFaucet();
  });

program
  .command("test-tee")
  .description("Validate TEE auth + RPC connectivity")
  .option("--debug", "print extra diagnostic output")
  .action(async (options) => {
    await runTestTee(options);
  });

if (process.argv.includes("-v") && !process.argv.includes("-V")) {
  console.log(VERSION);
  process.exit(0);
}

program.parseAsync(process.argv);
