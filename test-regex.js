const pat2 = /(?:folder|workspace|directory)\s+for\s+(?:my\s+|this\s+)?["']?([a-zA-Z0-9_\-. ]+?)["']?(?:\s+project\b|\s+on\b|\s*$|[.,!?])/i;
const match = "Create a workspace for my Hackathon project on the Desktop.".match(pat2);
console.log(match ? match[1] : 'null');
