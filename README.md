# Step Counter

A static, no-build web app that counts your walking steps in real time using
your phone's motion sensors (`devicemotion` / accelerometer). Pure HTML, CSS,
and JavaScript — no backend, no bundler, ready to deploy straight to GitHub
Pages.

## How it works

1. Tap **Start Tracking**. On iOS 13+ Safari this triggers a permission
   prompt for motion access (required by Apple, must be user-initiated).
   Android and most other browsers don't need this step.
2. The app listens to `devicemotion` events and reads
   `accelerationIncludingGravity` (or `acceleration` when the device
   provides it).
3. Each reading is converted to a single acceleration magnitude, smoothed
   with a low-pass filter, and run through a peak-detection algorithm to
   spot steps. See "Tuning the algorithm" below for details.
4. The step count is shown live and saved to `localStorage`, so a page
   refresh won't lose your progress. **Reset** zeroes the counter and
   clears the saved value.
5. A **Show Debug Info** toggle reveals the raw/smoothed signal values and
   the configured threshold, useful when tuning detection.

## Running locally

No build step is required. Just serve the folder with any static file
server, for example:

```bash
python3 -m http.server 8000
# then open http://localhost:8000 on your phone
```

Note: motion sensor APIs generally require a secure context (HTTPS) or
`localhost`. Testing over plain `http://<lan-ip>` from another device will
likely fail permission checks — use GitHub Pages (HTTPS) or a tunnel like
`ngrok` for real on-device testing over a network.

## Tuning the algorithm

The peak-detection constants live at the top of `script.js`:

| Constant              | Meaning                                                             |
| ---------------------- | -------------------------------------------------------------------- |
| `STEP_THRESHOLD`       | Smoothed acceleration magnitude (m/s²) a step must cross             |
| `MIN_STEP_INTERVAL_MS` | Minimum time between counted steps, to avoid double-counting         |
| `SMOOTHING_ALPHA`      | Exponential moving average factor (lower = smoother, slower signal)  |

- **Under-counting steps?** Lower `STEP_THRESHOLD` or raise
  `SMOOTHING_ALPHA` slightly so real footfalls cross the threshold.
- **Over-counting steps?** Raise `STEP_THRESHOLD`, or raise
  `MIN_STEP_INTERVAL_MS` if double-counts are happening on the same
  footfall.

Use the **Show Debug Info** toggle while walking with the phone in hand or
pocket to see live raw/smoothed values and pick good numbers for your use
case — sensor behavior varies noticeably between devices.

## Deploying to GitHub Pages

1. Create a new GitHub repository (or use an existing one) and push these
   files to it:

   ```bash
   git init
   git add .
   git commit -m "Initial commit: step counter app"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```

2. This repo includes a GitHub Actions workflow
   (`.github/workflows/deploy.yml`) that deploys the site to Pages on every
   push to `main`. To activate it: on GitHub, go to **Settings > Pages**,
   and under **Build and deployment**, set **Source** to **"GitHub
   Actions"** (this is a one-time setting — the workflow file handles the
   rest).
3. Push to `main` (or re-run the workflow manually from the **Actions**
   tab) to trigger a deployment. GitHub Pages will publish the site at
   `https://<your-username>.github.io/<your-repo>/` (usually within a
   minute or two). Check the **Actions** tab for the deployment status and
   the live URL.

**Important:** GitHub Pages serves over HTTPS by default, which is required
for the motion sensor APIs (`DeviceMotionEvent.requestPermission`, and
`devicemotion` in general) to work in most browsers — plain HTTP will not
work outside of `localhost`.

**Test on a real phone.** Desktop browser dev tools do not provide real
accelerometer data, so step detection must be verified on an actual phone
(walk around with it in your hand or pocket) rather than in a desktop
simulator.

## Contributing / Workflow

This repository treats `main` as **protected**. After the initial project
scaffold (committed directly to `main` to establish a working baseline),
all further changes follow this workflow:

1. Create a branch off `main` named `feature/<short-description>` or
   `fix/<short-description>` (e.g. `feature/add-distance-estimate`,
   `fix/ios-permission-bug`).
2. Make your changes on that branch.
3. Commit with a clear, conventional commit message (e.g.
   `feat: add distance estimate based on step count`).
4. Push the branch and open a pull request into `main` for review. No
   direct commits to `main` after the initial scaffold.
5. PRs are left open for manual review/merge unless explicitly requested
   otherwise.

**One-time manual setup recommended:** to actually enforce this on GitHub,
go to **Settings > Branches > Add rule** on the repository and add a
branch protection rule for `main` that requires a pull request before
merging.

## File structure

```
index.html   Markup and layout
style.css    Mobile-first styling, CSS variables for theming
script.js    Permission handling, motion listener, step-detection algorithm
README.md    This file
.gitignore   Standard static-site ignores
```
