#!/bin/bash

# Set variables
UMBREL_USER="umbrel"  # Change this if needed
UMBREL_IP="umbrel.local"  # Replace with your Umbrel node's IP
APP_DIR="/data/interactive-cp-map" # The directory where the app should be placed
LOCAL_APP_PATH="/Users/user/projects/interactive-cp-map"  # Replace with your local app folder path

echo "🔄 Deploying to Umbrel Node ($UMBREL_IP)..."
echo "🔄 Deploying to Umbrel Node ($UMBREL_IP)..."

# 1️⃣ Transfer files to Umbrel using SCP as root
echo "📤 Copying files to Umbrel's SSD..."
scp -r $LOCAL_APP_PATH umbrel@$UMBREL_IP:/home/umbrel/temp-app

# 2️⃣ SSH into Umbrel node and deploy
echo "🚀 Connecting via SSH and deploying..."
ssh umbrel@$UMBREL_IP << EOF
    echo "🔑 Switching to root..."
    sudo -i
    echo "📂 Moving files to /data..."
    mv /home/umbrel/temp-app $APP_DIR
    cd $APP_DIR
    echo "🛠️ Pulling latest changes..."
    sudo docker compose pull  # Pull latest images if needed
    echo "🔨 Building and restarting services..."
    sudo docker compose up -d --build
    echo "✅ Deployment complete!"
EOF

echo "🎉 Done!"