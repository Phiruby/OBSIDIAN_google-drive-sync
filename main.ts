import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from 'obsidian';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import * as path from 'path';
import { GaxiosPromise } from 'gaxios';
import * as fs from 'fs';
import { moment } from 'obsidian';

interface MyPluginSettings {
	googleDriveClientId: string;
	googleDriveClientSecret: string;
	googleDriveRefreshToken: string;
	lastSyncTimestamp: number | null;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	googleDriveClientId: process.env.GOOGLE_DRIVE_CLIENT_ID!,  // Replace with your Google Client ID
	googleDriveClientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET!,  // Replace with your Google Client Secret
	googleDriveRefreshToken: '',
	lastSyncTimestamp: null,
}

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	oauth2Client: OAuth2Client;
	private obsidianFolderId: string | null = null;
	private drivefolderIds: { [path: string]: string } = {};
	private fileIds: { [path: string]: string } = {};

	async onload() {
		await this.loadSettings();

		// Initialize OAuth2 Client
		this.initializeDriveService();

		// Add a command to log in to Google Drive
		this.addCommand({
			id: 'login-google-drive',
			name: 'Login to Google Drive',
			callback: async () => {
				await this.loginToGoogleDrive();
			},
		});

		// Add a command to sync with Google Drive
		this.addCommand({
			id: 'sync-with-google-drive',
			name: 'Sync with Google Drive',
			callback: async () => {
				if (!this.settings.googleDriveRefreshToken) {
					new Notice('You are not logged in. Please log in first.');
				} else {
					await this.syncWithGoogleDrive();
				}
			},
		});

		// Add a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new GoogleDriveSettingTab(this.app, this));

		// Load file IDs from storage
		this.fileIds = Object.assign({}, await this.loadData('fileIds') || {});
	}

	async onunload() {
		await this.saveData('fileIds', this.fileIds);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private initializeDriveService() {
		this.oauth2Client = new OAuth2Client(
			this.settings.googleDriveClientId,
			this.settings.googleDriveClientSecret,
			'http://localhost'  // Redirect URI for testing
		);

		if (this.settings.googleDriveRefreshToken) {
			this.oauth2Client.setCredentials({
				refresh_token: this.settings.googleDriveRefreshToken,
			});
		}
	}

	// Command to trigger Google Drive login
	async loginToGoogleDrive() {
		const authUrl = this.oauth2Client.generateAuthUrl({
			access_type: 'offline',  // Ensures we get a refresh token
			scope: ['https://www.googleapis.com/auth/drive.file'],  // Scope to access Google Drive
		});

		// Show the URL for user to log in
		new Notice('Please visit the URL in the console to authenticate.');
		console.log('Authorize this app by visiting this URL:');
		console.log(authUrl);

		// In production, the user would visit the URL and return an authorization code
		// For testing, the auth code will be manually entered
		const authCode = await this.promptForAuthCode();
		await this.exchangeCodeForTokens(authCode);
	}

	// Prompt user to enter the authorization code manually
	async promptForAuthCode(): Promise<string> {
		return new Promise((resolve) => {
			const promptModal = new AuthCodeModal(this.app, resolve);
			promptModal.open();
		});
	}

	// Exchange the authorization code for access and refresh tokens
	async exchangeCodeForTokens(authCode: string) {
		try {
			const { tokens } = await this.oauth2Client.getToken(authCode);
			this.oauth2Client.setCredentials(tokens);

			if (tokens.refresh_token) {
				this.settings.googleDriveRefreshToken = tokens.refresh_token;
				await this.saveSettings();
				new Notice('Logged in successfully and refresh token saved!');
			} else {
				new Notice('No refresh token received. Please try again.');
			}
		} catch (error) {
			console.error('Error exchanging authorization code for tokens:', error);
			new Notice('Authentication failed. Please try again.');
		}
	}

	// Sync with Google Drive
	async syncWithGoogleDrive() {
		if (!this.settings.googleDriveRefreshToken) {
			new Notice('Please log in to Google Drive first.');
			return;
		}

		try {
			await this.oauth2Client.getAccessToken();  // Refresh access token if needed

			new Notice('Syncing with Google Drive...');
			this.drivefolderIds = {}; // Reset the folder ID cache
			await this.ensureObsidianFolder();
			await this.uploadVaultContents();
			
			// Update last sync timestamp
			this.settings.lastSyncTimestamp = Date.now();
			await this.saveSettings();

			// Save file IDs to storage
			await this.saveData('fileIds', this.fileIds);

			new Notice('Sync complete!');
		} catch (error) {
			console.error('Error syncing with Google Drive:', error);
			new Notice('Error during sync. Please try again.');
		}
	}

	// Ensure the Obsidian folder exists in Google Drive
	async ensureObsidianFolder() {
		const drive = google.drive({ version: 'v3', auth: this.oauth2Client });
		const folderName = 'Obsidian Vault';

		// Check if the folder already exists
		const response = await drive.files.list({
			q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
			fields: 'files(id, name)',
		});

		if (response.data.files && response.data.files.length > 0) {
			this.obsidianFolderId = response.data.files[0].id;
		} else {
			// Create the folder if it doesn't exist
			const folderMetadata = {
				name: folderName,
				mimeType: 'application/vnd.google-apps.folder',
			};

			const folder = await drive.files.create({
				resource: folderMetadata,
				fields: 'id',
			});

			this.obsidianFolderId = folder.data.id;
		}

		this.drivefolderIds['/'] = this.obsidianFolderId;
		console.log(`Obsidian folder ID: ${this.obsidianFolderId}`);
	}

	// Upload all files from the Obsidian vault to Google Drive
	async uploadVaultContents() {
		const vault = this.app.vault;
		const rootFolder = vault.getRoot();
		await this.uploadFolderContents(rootFolder, '/');
	}

	// Recursively upload folder contents
	async uploadFolderContents(folder: TFolder, currentPath: string) {
		for (const item of folder.children) {
			if (item instanceof TFile) {
				await this.uploadObsidianFile(item, currentPath);
			} else if (item instanceof TFolder) {
				const newPath = path.join(currentPath, item.name);
				await this.ensureDriveFolder(newPath);
				await this.uploadFolderContents(item, newPath);
			}
		}
	}

	// Ensure a folder exists in Google Drive
	async ensureDriveFolder(folderPath: string): Promise<string> {
		const drive = google.drive({ version: 'v3', auth: this.oauth2Client });
		const pathParts = folderPath.split(path.sep).filter(part => part.length > 0);
		let currentPath = '';
		let parentId = this.obsidianFolderId;

		for (const part of pathParts) {
			currentPath = path.join(currentPath, part);
			
			if (this.drivefolderIds[currentPath]) {
				parentId = this.drivefolderIds[currentPath];
				continue;
			}

			const response = await drive.files.list({
				q: `name='${part}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`,
				fields: 'files(id, name)',
			});

			if (response.data.files && response.data.files.length > 0) {
				parentId = response.data.files[0].id;
			} else {
				const folderMetadata = {
					name: part,
					mimeType: 'application/vnd.google-apps.folder',
					parents: [parentId],
				};

				const folder = await drive.files.create({
					resource: folderMetadata,
					fields: 'id',
				});

				parentId = folder.data.id;
			}

			this.drivefolderIds[currentPath] = parentId;
		}

		return parentId;
	}

	// Upload an Obsidian file to Google Drive
	async uploadObsidianFile(file: TFile, currentPath: string) {
		const fileName = file.name;
		const mimeType = this.getMimeType(file.extension);
		const filePath = path.join(currentPath, fileName);

		// Check if file has been modified since last sync or if it's the first sync
		if (this.settings.lastSyncTimestamp !== null && file.stat.mtime <= this.settings.lastSyncTimestamp) {
			console.log(`Skipping ${filePath} - not modified since last sync`);
			return;
		}

		let content: string | ArrayBuffer;
		if (mimeType.startsWith('text/') || mimeType === 'application/json') {
			content = await this.app.vault.read(file);
		} else {
			content = await this.app.vault.readBinary(file);
		}

		const fileId = await this.uploadFile(filePath, content, mimeType);
		if (fileId) {
			this.fileIds[filePath] = fileId;
		}
	}

	// Upload a file to Google Drive
	async uploadFile(filePath: string, content: string | ArrayBuffer, mimeType: string): Promise<string | null> {
		const drive = google.drive({ version: 'v3', auth: this.oauth2Client });
		const parentPath = path.dirname(filePath);
		const fileName = path.basename(filePath);

		const parentId = await this.ensureDriveFolder(parentPath);

		const fileMetadata = {
			name: fileName,
			parents: [parentId],
		};
		const media = { mimeType, body: content };

		try {
			let file;
			if (this.fileIds[filePath]) {
				// Update existing file
				file = await drive.files.update({
					fileId: this.fileIds[filePath],
					requestBody: fileMetadata,
					media: media,
					fields: 'id',
				});
				console.log(`File updated: ${filePath}, ID: ${file.data.id}`);
			} else {
				// Create new file
				file = await drive.files.create({
					requestBody: fileMetadata,
					media: media,
					fields: 'id',
				});
				console.log(`File created: ${filePath}, ID: ${file.data.id}`);
			}
			return file.data.id;
		} catch (err) {
			console.error(`Error uploading file ${filePath}:`, err);
			return null;
		}
	}

	// Determine the MIME type based on the file extension
	getMimeType(extension: string): string {
		switch (extension.toLowerCase()) {
			case 'md':
				return 'text/markdown';
			case 'png':
				return 'image/png';
			case 'jpg':
			case 'jpeg':
				return 'image/jpeg';
			case 'gif':
				return 'image/gif';
			case 'json':
				return 'application/json';
			default:
				return 'application/octet-stream';
		}
	}
}

// Modal to prompt user for authorization code
class AuthCodeModal extends Modal {
	private resolve: (value: string) => void;

	constructor(app: App, resolve: (value: string) => void) {
		super(app);
		this.resolve = resolve;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: 'Enter Google Auth Code' });

		const inputEl = contentEl.createEl('input', { type: 'text' });
		const submitButton = contentEl.createEl('button', { text: 'Submit' });

		submitButton.addEventListener('click', () => {
			const authCode = inputEl.value;
			this.resolve(authCode);
			this.close();
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// Settings tab for Google Drive plugin
class GoogleDriveSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Google Drive Client ID')
			.setDesc('Enter your Google Drive Client ID')
			.addText(text => text
				.setPlaceholder('Enter your Client ID')
				.setValue(this.plugin.settings.googleDriveClientId)
				.onChange(async (value) => {
					this.plugin.settings.googleDriveClientId = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Google Drive Client Secret')
			.setDesc('Enter your Google Drive Client Secret')
			.addText(text => text
				.setPlaceholder('Enter your Client Secret')
				.setValue(this.plugin.settings.googleDriveClientSecret)
				.onChange(async (value) => {
					this.plugin.settings.googleDriveClientSecret = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Google Drive Refresh Token')
			.setDesc('Enter your Google Drive Refresh Token manually (optional)')
			.addText(text => text
				.setPlaceholder('Enter your Refresh Token')
				.setValue(this.plugin.settings.googleDriveRefreshToken)
				.onChange(async (value) => {
					this.plugin.settings.googleDriveRefreshToken = value;
					await this.plugin.saveSettings();
				}));
	}
}