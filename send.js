
let peer = null;
let conn = null;
let aesKey = null;
let aesIv = null;
let aesKeyExchangeComplete = false;

const pingIdSpan = document.getElementById('pingId');
const copyBtn = document.getElementById('copyBtn');
const connectionStatus = document.getElementById('connectionStatus');
const fileCard = document.getElementById('fileCard');
const sendBtn = document.getElementById('sendBtn');
const fileInput = document.getElementById('fileInput');
const dropArea = document.getElementById('dropArea');
const fileList = document.getElementById('fileList');
const fileForm = document.getElementById('fileForm');
const simulateConnectBtn = document.getElementById('simulateConnect');

// Custom file list management
let selectedFiles = [];

// Helper: Remove only file selection UI
function clearFileSelectionUI() {
    // Remove only elements with the remove button (file selection rows)
    const children = Array.from(fileList.children);
    children.forEach(child => {
        if (child.querySelector && child.querySelector('button.btn-small')) {
            fileList.removeChild(child);
        }
    });
}

// Generate AES-GCM key and IV
async function generateAesKey() {
    aesKey = await window.crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
    );
    aesIv = window.crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for GCM
}

// Export AES key as raw
async function exportAesKey() {
    const rawKey = await window.crypto.subtle.exportKey('raw', aesKey);
    return new Uint8Array(rawKey);
}

// Encrypt data with AES-GCM
async function encryptData(data) {
    return new Uint8Array(await window.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: aesIv },
        aesKey,
        data
    ));
}

// Set up PeerJS
function setupPeer() {
    peer = new Peer({
        host: '0.peerjs.com',
        port: 443,
        secure: true,
        debug: 3
    });
    peer.on('open', (id) => {
        pingIdSpan.textContent = id;
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(id).then(() => {
                copyBtn.textContent = 'Copied!';
                setTimeout(() => copyBtn.textContent = 'Copy ID', 1200);
            });
        };
    });
    peer.on('connection', async (connection) => {
        conn = connection;
        connectionStatus.innerHTML = '<span class="dot connected"></span> Connected (Setting up encryption...)';
        connectionStatus.classList.remove('waiting');
        connectionStatus.classList.add('connected');
        fileCard.style.display = 'block';
        sendBtn.disabled = true;  // Disable send button until encryption is ready
        if (simulateConnectBtn) simulateConnectBtn.style.display = 'none';
        
        // Only send AES key after the connection is open
        conn.on('open', async () => {
            await generateAesKey();
            const rawKey = await exportAesKey();
            const aesKeyMsg = JSON.stringify({ type: 'aes-key', key: Array.from(rawKey), iv: Array.from(aesIv) });
            conn.send(aesKeyMsg);
            console.log('[SEND] Sent AES key:', aesKeyMsg);
            aesKeyExchangeComplete = true;
            connectionStatus.innerHTML = '<span class="dot connected"></span> Connected (Ready to transfer)';
            if (selectedFiles.length > 0) {
                sendBtn.disabled = false;  // Re-enable send button if files are selected
            }
        });
    });
}

document.addEventListener('DOMContentLoaded', () => {
    setupPeer();

    // Hide simulate button for real connection
    if (simulateConnectBtn) simulateConnectBtn.style.display = 'none';

    // Drag and drop logic
    dropArea.addEventListener('click', () => fileInput.click());
    dropArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropArea.classList.add('dragover');
    });
    dropArea.addEventListener('dragleave', () => {
        dropArea.classList.remove('dragover');
    });
    dropArea.addEventListener('drop', (e) => {
        e.preventDefault();
        dropArea.classList.remove('dragover');
        addFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', () => {
        addFiles(fileInput.files);
        fileInput.value = '';
    });

    function addFiles(fileListInput) {
        const newFiles = Array.from(fileListInput);
        newFiles.forEach(file => {
            if (!selectedFiles.some(f => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified)) {
                selectedFiles.push(file);
            }
        });
        updateFileList();
    }

    function removeFile(index) {
        selectedFiles.splice(index, 1);
        updateFileList();
    }

    function updateFileList() {
        // Only remove file selection UI, not progress/status elements
        clearFileSelectionUI();
        if (selectedFiles.length > 0) {
            sendBtn.disabled = !aesKeyExchangeComplete; // Only enable if encryption is ready
            selectedFiles.forEach((file, idx) => {
                const div = document.createElement('div');
                div.textContent = file.name + ' (' + Math.round(file.size/1024) + ' KB)';
                const removeBtn = document.createElement('button');
                removeBtn.textContent = '✕';
                removeBtn.className = 'btn btn-small btn-white';
                removeBtn.style.marginLeft = '10px';
                removeBtn.onclick = () => removeFile(idx);
                div.appendChild(removeBtn);
                fileList.appendChild(div);
            });
        } else {
            sendBtn.disabled = true;
        }
    }

    fileForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        // Add retry logic for AES key exchange
        if (conn && conn.open && !aesKeyExchangeComplete) {
            // Wait up to 3 seconds for AES key exchange to complete
            for (let i = 0; i < 15; i++) {
                if (aesKeyExchangeComplete) break;
                await new Promise(res => setTimeout(res, 200));
            }
        }

        if (conn && conn.open && aesKeyExchangeComplete) {
            const files = selectedFiles;
            if (!files.length) return;
            
            // Increased wait time to ensure receiver is ready
            await new Promise(res => setTimeout(res, 500));
            
            async function sendFile(file) {
                return new Promise((resolve) => {
                    const metadataMsg = { type: 'metadata', name: file.name, size: file.size, mime: file.type };
                    console.log('Sending metadata:', metadataMsg);
                    
                    // Add retry logic for sending metadata
                    let retries = 3;
                    const sendMetadata = () => {
                        try {
                            conn.send(JSON.stringify(metadataMsg));
                        } catch (err) {
                            if (retries > 0) {
                                retries--;
                                setTimeout(sendMetadata, 200);
                            }
                        }
                    };
                    sendMetadata();

                    const chunkSize = 8 * 1024; // 8 KB
                    let offset = 0;
                    let reader = new FileReader();
                    const progressDiv = document.createElement('div');
                    progressDiv.textContent = `Sending: 0% (${file.name})`;
                    const progressBar = document.createElement('div');
                    progressBar.className = 'progress-container';
                    const bar = document.createElement('div');
                    bar.className = 'progress-bar';
                    progressBar.appendChild(bar);
                    fileList.appendChild(progressDiv);
                    fileList.appendChild(progressBar);

                    async function sendChunk() {
                        const slice = file.slice(offset, offset + chunkSize);
                        reader.onload = async function(e) {
                            // Encrypt chunk before sending
                            const encrypted = await encryptData(e.target.result);
                            // Send as raw ArrayBuffer
                            conn.send(encrypted.buffer);
                            offset += chunkSize;
                            const percent = Math.min(100, Math.round((offset / file.size) * 100));
                            progressDiv.textContent = `Sending: ${percent}% (${file.name})`;
                            bar.style.width = percent + '%';
                            if (offset < file.size) {
                                sendChunk();
                            } else {
                                const doneMsg = { type: 'done' };
                                console.log('Sending done:', doneMsg);
                                conn.send(JSON.stringify(doneMsg));
                                progressDiv.textContent = `File sent! (${file.name})`;
                                bar.style.width = '100%';
                                resolve();
                            }
                        };
                        reader.readAsArrayBuffer(slice);
                    }
                    sendChunk();
                });
            }
            for (const file of files) {
                await sendFile(file);
            }
            selectedFiles = [];
            updateFileList();
        } else {
            if (!aesKeyExchangeComplete) {
                alert('Please wait for secure connection setup to complete...');
            } else {
                alert('Not connected to a receiver!');
            }
        }
    });
}); 
