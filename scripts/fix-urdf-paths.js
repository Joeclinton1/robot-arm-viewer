#!/usr/bin/env node

/**
 * Automatically fixes URDF file paths to use relative paths
 * Converts package:// URIs and absolute paths to relative paths
 *
 * Usage: node scripts/fix-urdf-paths.js [--backup]
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const createBackup = args.includes('--backup');

const urdfDir = path.join(__dirname, '..', 'urdf');

/**
 * Recursively find all URDF files
 */
function findUrdfFiles(dir) {
    const urdfFiles = [];

    function scan(currentDir) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);

            if (entry.isDirectory()) {
                scan(fullPath);
            } else if (entry.isFile() && entry.name.endsWith('.urdf')) {
                urdfFiles.push(fullPath);
            }
        }
    }

    scan(dir);
    return urdfFiles;
}

/**
 * Fix mesh paths in URDF content
 */
function fixUrdfPaths(urdfContent, urdfFilePath) {
    const urdfDir = path.dirname(urdfFilePath);
    const urdfDirName = path.basename(urdfDir);
    let modified = false;

    // Check if URDF is in a urdf/ subfolder
    const isInUrdfSubfolder = urdfDirName.toLowerCase() === 'urdf';
    const robotRootDir = isInUrdfSubfolder ? path.dirname(urdfDir) : urdfDir;

    // Match <mesh filename="..."/> or <mesh filename="...">
    const meshRegex = /<mesh\s+filename="([^"]+)"/g;

    const fixed = urdfContent.replace(meshRegex, (match, filepath) => {
        const original = filepath;
        let newPath = filepath;

        // Convert package:// URIs
        if (filepath.startsWith('package://')) {
            // Remove package:// prefix
            // Format: package://package_name/path/to/file
            const withoutPackage = filepath.replace(/^package:\/\/[^\/]+\//, '');
            newPath = withoutPackage;
            modified = true;
        }
        // Convert absolute paths
        else if (filepath.startsWith('/') || /^[A-Za-z]:/.test(filepath)) {
            // Try to extract the relative portion
            // Look for meshes/ or assets/ in the path
            const meshesMatch = filepath.match(/\/(meshes|assets)\/.+$/);
            if (meshesMatch) {
                newPath = meshesMatch[0].substring(1); // Remove leading slash
                modified = true;
            }
        }
        // Fix paths that go up directories unnecessarily
        else if (filepath.startsWith('../')) {
            // Check if file exists with this path
            const absolutePath = path.join(urdfDir, filepath);
            if (!fs.existsSync(absolutePath)) {
                // Try without the ../
                const simplified = filepath.replace(/^(\.\.\/)+/, '');
                const simplifiedPath = path.join(urdfDir, simplified);
                if (fs.existsSync(simplifiedPath)) {
                    newPath = simplified;
                    modified = true;
                }
            }
        }

        // If URDF is in urdf/ subfolder, check if we need to add ../
        if (isInUrdfSubfolder && !newPath.startsWith('../')) {
            // Check if mesh file exists relative to URDF location
            const relativeToUrdf = path.join(urdfDir, newPath);
            const relativeToRoot = path.join(robotRootDir, newPath);

            // If doesn't exist relative to URDF but exists relative to root, add ../
            if (!fs.existsSync(relativeToUrdf) && fs.existsSync(relativeToRoot)) {
                newPath = '../' + newPath;
                modified = true;
            }
        }

        // Normalize path separators to forward slashes
        newPath = newPath.replace(/\\/g, '/');

        if (newPath !== original) {
            console.log(`  ${original}`);
            console.log(`  -> ${newPath}`);
        }

        return `<mesh filename="${newPath}"`;
    });

    return { fixed, modified };
}

/**
 * Process a single URDF file
 */
function processUrdfFile(urdfPath) {
    console.log(`\nProcessing: ${path.relative(urdfDir, urdfPath)}`);

    // Read URDF file
    const content = fs.readFileSync(urdfPath, 'utf8');

    // Fix paths
    const { fixed, modified } = fixUrdfPaths(content, urdfPath);

    if (modified) {
        // Create backup if requested
        if (createBackup) {
            const backupPath = urdfPath + '.backup';
            fs.writeFileSync(backupPath, content, 'utf8');
            console.log(`  Created backup: ${path.basename(backupPath)}`);
        }

        // Write fixed content
        fs.writeFileSync(urdfPath, fixed, 'utf8');
        console.log(`  ✓ Updated`);
    } else {
        console.log(`  ✓ No changes needed`);
    }
}

/**
 * Main
 */
console.log('URDF Path Fixer');
console.log('===============\n');

if (createBackup) {
    console.log('Backup mode: ON (.backup files will be created)\n');
}

// Find all URDF files
const urdfFiles = findUrdfFiles(urdfDir);

if (urdfFiles.length === 0) {
    console.log('No URDF files found!');
    process.exit(0);
}

console.log(`Found ${urdfFiles.length} URDF file(s)`);

// Process each file
urdfFiles.forEach(processUrdfFile);

console.log('\n✓ Done!');
