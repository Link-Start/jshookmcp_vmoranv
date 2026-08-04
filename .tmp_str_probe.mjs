const path = 'C:\\Windows\\System32\\svchost.exe'.toLowerCase();
console.log(JSON.stringify(path));
console.log('has windows seg:', path.includes('\\windows\\'));
console.log('has svchost:', path.includes('svchost.exe'));
