# Obsidian Plugin to Upload Files to Google Drive
First, login (press ```ctrl+p``` and type ```login-google-drive```). Then there will be a link in the developer console (```ctrl+shift+i``` to view this) .
Follow this link and login to google. THen you will be redirected to a page. In the URL, copy everything after ```code=``` and paste it into the ```Google Drive Refresh Token``` field in the plugin settings.

Now you can press ```ctrl+p``` and type ```upload-to-google-drive``` to upload the current file to google drive.
(Note if this does not work, you may need to set client id and client secret in the .env file)
