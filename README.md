# Hackatime for Visual Studio Code

[Hackatime][hackatime] is an open source VS Code plugin for metrics, insights, and time tracking automatically generated from your programming activity.

## Installation

1. Press `F1` or `⌘ + Shift + P` and type `install`. Pick `Extensions: Install Extension`.

   ![type install](./images/type-install.png)

2. Type `hackatime` and hit `enter`.

3. Log in with your Hackatime account.

   > (If you’re not prompted, press `F1` or `⌘ + Shift + P` then type `Hackatime Login`.)

4. Use VSCode and your coding activity will be displayed on your [Hackatime dashboard](https://hackatime.hackclub.com)

## Usage

Visit [https://hackatime.hackclub.com](https://hackatime.hackclub.com) to see your coding activity.

## Configuring

VS Code specific settings are available from `⌘ + Shift + P`, then typing `hackatime`.

For example, to hide today's coding activity in your status bar:

Press `⌘ + Shift + P` then set `Hackatime: Status Bar Coding Activity` to `false`.

### Status Bar Alignment

You can customize the position and priority of the Hackatime status bar item:

- **Alignment**: Set `hackatime.align` to `left` or `right` to control which side of the status bar shows the Hackatime item
- **Priority**: Set `hackatime.alignPriority` to a number to control the order (higher values appear more to the left)

Both settings require restarting VS Code to take effect.

Extension settings are stored in the INI file at `$HOME/.wakatime.cfg`.

More information can be found from [wakatime-cli][wakatime-cli configs].

If using an online IDE like [gitpods](https://gitpod.io/), add your [api key][api key] to global ENV key `HACKATIME_API_KEY`.

Notes:

1. `$HOME` defaults to `$HOME`
1. To disable the extension at startup add `disabled=true` to your config, this operation can also be performed by pressing `⌘ + Shift + P` and selecting `Hackatime: Disable`.

## Troubleshooting

First, turn on debug mode:

1. Press `F1` or `⌘ + Shift + P`
2. Type `> Hackatime: Debug`, and press `Enter`.
3. Select `true`, then press `Enter`.

Next, open your Developer Console to view logs and errors:

`Help → Toggle Developer Tools`

Errors outside the scope of vscode-hackatime go to `$HOME/.wakatime/wakatime.log` from [wakatime-cli][wakatime-cli help].

If your error message contains "won't send heartbeat due to backoff" then delete your `~/.wakatime/wakatime-internal.cfg` file to trigger an API connection so we can see the real error message.

The [How to Debug Plugins][how to debug] guide shows how to check when coding activity was last received from your editor using the [Plugins Status Page][plugins status page].

**Microsoft Windows Only:** Using Hackatime behind a corporate proxy? Try enabling your Windows Root Certs inside VS Code with the [win-ca][winca] extension:
Press `Ctrl + Shift + X`, search for `win-ca`, press `Install`.

For more general troubleshooting info, see the [wakatime-cli Troubleshooting Section][wakatime-cli help].

### SSH configuration

If you're connected to a remote host using the [ssh extension](https://code.visualstudio.com/docs/remote/ssh) you might want to force Hackatime to run locally instead on the server. This configuration is needed when the server you connect is shared among other people. Please follow [this](https://code.visualstudio.com/docs/remote/ssh#_advanced-forcing-an-extension-to-run-locally-remotely) guide.

## Uninstalling

1. Click the Extensions sidebar item in VS Code.

2. Type `hackatime` and hit enter.

3. Click the settings icon next to Hackatime, then click Uninstall.

4. Delete the `~/.wakatime*` files in your home directory, unless you’re still using Hackatime with another IDE.

## Contributing

Pull requests, bug reports, and feature requests are welcome!
Please search [existing issues][issues] before creating a new one.

To run from source:

1. `git clone git@github.com:ImShyMike/vscode-hackatime.git`
2. `cd vscode-hackatime`
3. `npm install`
4. `npm run watch`
5. Install the extension from the marketplace
6. Then symlink `~/.vscode/extensions/hackatime.vscode-hackatime-extension-dev-*/dist/extension.js` to `./dist/extension.js`

Or to run the web version from source:

1. `git clone git@github.com:ImShyMike/vscode-hackatime.git`
2. `cd vscode-hackatime`
3. `npm install`
4. `npm run compile`
5. `npm run open-in-browser`
6. Go to [localhost:3000](http://localhost:3000/) in your web browser

[hackatime]: https://hackatime.hackclub.com/docs/editors/vs-code
[api key]: https://hackatime.hackclub.com/my/wakatime_setup
[wakatime-cli help]: https://github.com/wakatime/wakatime-cli/blob/develop/TROUBLESHOOTING.md
[wakatime-cli configs]: https://github.com/wakatime/wakatime-cli/blob/develop/USAGE.md
[how to debug]: https://hackatime.hackclub.com/docs
[plugins status page]: https://hackatime.hackclub.com/docs
[winca]: https://github.com/ukoloff/win-ca/tree/master/vscode
[issues]: https://github.com/ImShyMike/vscode-hackatime/issues
