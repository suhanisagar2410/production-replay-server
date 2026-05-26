# Build the backend locally
npm run build

# Securely copy the updated compiled code and dependencies to the live server
scp -o StrictHostKeyChecking=no -i "C:\Users\Lenovo\Downloads\replay-key.pem" -r dist package.json package-lock.json prisma ubuntu@13.61.174.212:/home/ubuntu/production-replay-server/

# SSH into the server, install any new dependencies, and restart PM2
ssh -o StrictHostKeyChecking=no -i "C:\Users\Lenovo\Downloads\replay-key.pem" ubuntu@13.61.174.212 "cd ~/production-replay-server && npm install --omit=dev && npx prisma generate && pm2 restart all"

echo "Backend Deployment Complete!"
