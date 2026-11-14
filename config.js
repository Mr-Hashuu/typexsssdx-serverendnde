'use strict';
// Fill these 3 values, push to GitHub, deploy on Render. No environment variables needed.
// Keep this GitHub repo PRIVATE because the password and database link are in this file.
module.exports = {
  // MongoDB Atlas connection string, for example: mongodb+srv://user:pass@cluster0.abcde.mongodb.net/
  mongodbUri: '',
  // Password for the admin panel
  adminPassword: '',
  // Any long random text (used to sign admin logins)
  sessionSecret: 'change-this-to-any-long-random-text',
  // Database name inside MongoDB
  dbName: 'typex'
};
