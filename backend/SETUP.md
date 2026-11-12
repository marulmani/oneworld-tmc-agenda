# Members' Portal setup (about 15 minutes, once)

The portal (`members.html`) stores everything in a Google Sheet owned by the club.
Members sign in with their Google account; only emails listed in the sheet's **Members** tab get in.

## 1. Create the sheet and add the script
1. Sign in to the club's Google account and create a new Google Sheet, e.g. **OneWorld TMC Portal**.
2. In the sheet: **Extensions → Apps Script**. Delete the sample code.
3. Paste the whole of [`Code.gs`](Code.gs) and click **Save**.
4. Choose the `setup` function in the toolbar and click **Run**. Approve the permissions (it is your own script).
   This creates the tabs **Members, Meetings, Bookings, Pathways, Log**, adds you as an admin, and adds meeting #362.

## 2. Add members
In the **Members** tab, one row per member:

| email | name | designation | office | access | active |
|---|---|---|---|---|---|
| gladys@example.com | Gladys Choo | DTM | VP Membership | member | yes |
| someone@gmail.com | Lewis Low | DL4 | Sergeant at Arms | member | yes |

- `office` is the exco office, blank for ordinary members.
- **President, VP Education and Secretary are admins automatically**: they can add meetings and book or cancel for anyone. Set `access` to `admin` to give anyone else the same rights.
- Set `active` to `no` to remove someone's access without deleting history.

## 3. Create a Google sign-in Client ID
1. Open <https://console.cloud.google.com/>, create a project (e.g. *OneWorld TMC*).
2. **APIs & Services → OAuth consent screen**: User type **External**, app name *OneWorld TMC Members*, your email as support and developer contact. Save. Then **Publish app** (sign-in only asks for name and email, so no Google review is needed).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID** → *Web application*.
   - **Authorized JavaScript origins:** `https://marulmani.github.io`
4. Copy the **Client ID** (ends in `.apps.googleusercontent.com`).
5. Back in Apps Script, paste it into `CONFIG.CLIENT_ID` at the top of `Code.gs` and **Save**.

## 4. Deploy the script as a web app
1. Apps Script: **Deploy → New deployment → type: Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
   (Visitors still need a valid Google sign-in **and** a row in Members to read or change member data. Only the public line-up is open.)
2. Click **Deploy** and copy the **Web app URL** (ends in `/exec`).
3. After any later change to `Code.gs`: **Deploy → Manage deployments → Edit → Version: New version → Deploy** (the URL stays the same).

## 5. Connect the website
Edit [`config.js`](../config.js) in the GitHub repo (pencil icon → commit):

```js
window.OWTM_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/XXXX/exec',
  GOOGLE_CLIENT_ID: '1234-abc.apps.googleusercontent.com',
  SHEET_URL: 'https://docs.google.com/spreadsheets/d/XXXX/edit'   // optional: admin shortcut
};
```

Within a minute or two:
- `members.html` shows a **Sign in with Google** button.
- The public page's line-up, theme and Word of the Day come live from the sheet. No more uploading `data.json` for role changes.

## Each meeting cycle
- **VPE** adds the next meetings in the portal's **Admin** tab (number, date, theme, Word of the Day).
- **Members** book roles and speaking slots themselves, and keep their Pathways progress up to date.
- **VPE** checks **Book a Role → Overview** for open roles and books members in where needed.
- After the meeting, set its status to `done` in Admin. It moves into everyone's role history.

## Privacy
- Member emails are only returned to admins. Other members see names only.
- Every booking, cancellation and Pathways change is written to the **Log** tab with who did it.
- The sheet stays private to the club account; the script reads it on members' behalf.
