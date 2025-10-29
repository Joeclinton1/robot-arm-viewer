import * as THREE from 'three';

// OBJ Exporter for URDF robots
// Exports the current state of the robot to OBJ format with all meshes combined
export class OBJExporter {
    constructor() {
        this.output = '';
        this.mtlOutput = '';
        this.vertexOffset = 1;
        this.normalOffset = 1;
        this.uvOffset = 1;
        this.materials = new Map();
        this.materialIndex = 0;
    }

    parse(object, filename = 'robot') {
        this.output = '';
        this.mtlOutput = '';
        this.vertexOffset = 1;
        this.normalOffset = 1;
        this.uvOffset = 1;
        this.materials.clear();
        this.materialIndex = 0;

        // Extract base name without extension
        const baseName = filename.replace('.obj', '');

        // OBJ file header
        this.output += '# OBJ file exported from URDF Viewer\n';
        this.output += `# Date: ${new Date().toISOString()}\n`;
        this.output += '\n';

        // Parse the object
        this.parseObject(object, baseName);

        // Generate MTL file
        this.generateMTL();

        return { obj: this.output, mtl: this.mtlOutput };
    }

    parseObject(object, objectName = 'URDFRobot') {
        const vertices = [];
        const normals = [];
        const uvs = [];
        const meshGroups = [];

        // Traverse all meshes in the object
        object.traverse(child => {
            if (child.isMesh && child.geometry) {
                const faces = [];
                this.parseMesh(child, vertices, normals, uvs, faces);
                if (faces.length > 0) {
                    const materialName = this.getMaterialName(child.material);
                    meshGroups.push({ faces, materialName });
                }
            }
        });

        // Write header for this object
        if (vertices.length > 0) {
            // Reference MTL file
            this.output += `mtllib ${objectName}.mtl\n`;
            this.output += `o ${objectName}\n`;

            // Write all vertices
            vertices.forEach(v => {
                this.output += `v ${v.x.toFixed(6)} ${v.y.toFixed(6)} ${v.z.toFixed(6)}\n`;
            });

            // Write all normals
            if (normals.length > 0) {
                normals.forEach(n => {
                    this.output += `vn ${n.x.toFixed(6)} ${n.y.toFixed(6)} ${n.z.toFixed(6)}\n`;
                });
            }

            // Write all UVs
            if (uvs.length > 0) {
                uvs.forEach(uv => {
                    this.output += `vt ${uv.x.toFixed(6)} ${uv.y.toFixed(6)}\n`;
                });
            }

            // Write all faces grouped by material
            meshGroups.forEach(group => {
                this.output += `usemtl ${group.materialName}\n`;
                group.faces.forEach(face => {
                    this.output += face + '\n';
                });
            });

            this.output += '\n';
        }
    }

    getMaterialName(material) {
        if (!material) return 'default_material';

        // Check if we've already registered this material
        for (const [name, mat] of this.materials.entries()) {
            if (mat === material) return name;
        }

        // Create a new material name
        const name = `material_${this.materialIndex++}`;
        this.materials.set(name, material);
        return name;
    }

    generateMTL() {
        this.mtlOutput = '# MTL file exported from URDF Viewer\n';
        this.mtlOutput += `# Date: ${new Date().toISOString()}\n\n`;

        for (const [name, material] of this.materials.entries()) {
            this.mtlOutput += `newmtl ${name}\n`;

            // Get material color
            const color = material.color || new THREE.Color(0.8, 0.8, 0.8);
            this.mtlOutput += `Kd ${color.r.toFixed(4)} ${color.g.toFixed(4)} ${color.b.toFixed(4)}\n`;

            // Ambient color (usually same as diffuse or slightly darker)
            this.mtlOutput += `Ka ${(color.r * 0.5).toFixed(4)} ${(color.g * 0.5).toFixed(4)} ${(color.b * 0.5).toFixed(4)}\n`;

            // For PBR materials (MeshStandardMaterial)
            if (material.type === 'MeshStandardMaterial') {
                const metalness = material.metalness !== undefined ? material.metalness : 0.0;
                const roughness = material.roughness !== undefined ? material.roughness : 0.5;

                // Convert roughness to specular exponent (approximate)
                const specularExponent = (1.0 - roughness) * 200 + 10;
                this.mtlOutput += `Ns ${specularExponent.toFixed(2)}\n`;

                // Specular color (small white for non-metallic, material color for metallic)
                // Non-metals have ~4% reflection (0.04), metals reflect their color
                const baseSpec = 0.04;
                const specR = color.r * metalness + baseSpec * (1.0 - metalness);
                const specG = color.g * metalness + baseSpec * (1.0 - metalness);
                const specB = color.b * metalness + baseSpec * (1.0 - metalness);
                this.mtlOutput += `Ks ${specR.toFixed(4)} ${specG.toFixed(4)} ${specB.toFixed(4)}\n`;
            } else {
                // Default specular properties
                this.mtlOutput += `Ns 50.0\n`;
                this.mtlOutput += `Ks 0.04 0.04 0.04\n`;
            }

            // Transparency
            const opacity = material.opacity !== undefined ? material.opacity : 1.0;
            this.mtlOutput += `d ${opacity.toFixed(4)}\n`;

            // Illumination model (2 = highlight on)
            this.mtlOutput += `illum 2\n`;

            this.mtlOutput += '\n';
        }
    }

    parseMesh(mesh, vertices, normals, uvs, faces) {
        const geometry = mesh.geometry;

        // Ensure geometry has the necessary attributes
        if (!geometry.attributes.position) {
            return;
        }

        // Clone geometry to avoid modifying the original
        const geo = geometry.clone();

        // Apply mesh transformations
        mesh.updateMatrixWorld();
        geo.applyMatrix4(mesh.matrixWorld);

        // Compute normals if they don't exist
        if (!geo.attributes.normal) {
            geo.computeVertexNormals();
        }

        const positions = geo.attributes.position;
        const normalsAttr = geo.attributes.normal;
        const uvsAttr = geo.attributes.uv;
        const indices = geo.index;

        const vertexStart = vertices.length;
        const normalStart = normals.length;
        const uvStart = uvs.length;

        // Extract vertices
        for (let i = 0; i < positions.count; i++) {
            vertices.push(new THREE.Vector3(
                positions.getX(i),
                positions.getY(i),
                positions.getZ(i)
            ));
        }

        // Extract normals
        if (normalsAttr) {
            for (let i = 0; i < normalsAttr.count; i++) {
                const normal = new THREE.Vector3(
                    normalsAttr.getX(i),
                    normalsAttr.getY(i),
                    normalsAttr.getZ(i)
                );
                // Transform normal by the mesh's world matrix (rotation only)
                normal.transformDirection(mesh.matrixWorld);
                normals.push(normal);
            }
        }

        // Extract UVs
        if (uvsAttr) {
            for (let i = 0; i < uvsAttr.count; i++) {
                uvs.push(new THREE.Vector2(
                    uvsAttr.getX(i),
                    uvsAttr.getY(i)
                ));
            }
        }

        // Extract faces
        const hasUVs = uvsAttr !== undefined;
        const hasNormals = normalsAttr !== undefined;

        if (indices) {
            // Indexed geometry
            for (let i = 0; i < indices.count; i += 3) {
                const a = indices.getX(i) + vertexStart + this.vertexOffset;
                const b = indices.getX(i + 1) + vertexStart + this.vertexOffset;
                const c = indices.getX(i + 2) + vertexStart + this.vertexOffset;

                let face = 'f ';

                if (hasUVs && hasNormals) {
                    const an = indices.getX(i) + normalStart + this.normalOffset;
                    const bn = indices.getX(i + 1) + normalStart + this.normalOffset;
                    const cn = indices.getX(i + 2) + normalStart + this.normalOffset;
                    const at = indices.getX(i) + uvStart + this.uvOffset;
                    const bt = indices.getX(i + 1) + uvStart + this.uvOffset;
                    const ct = indices.getX(i + 2) + uvStart + this.uvOffset;
                    face += `${a}/${at}/${an} ${b}/${bt}/${bn} ${c}/${ct}/${cn}`;
                } else if (hasNormals) {
                    const an = indices.getX(i) + normalStart + this.normalOffset;
                    const bn = indices.getX(i + 1) + normalStart + this.normalOffset;
                    const cn = indices.getX(i + 2) + normalStart + this.normalOffset;
                    face += `${a}//${an} ${b}//${bn} ${c}//${cn}`;
                } else if (hasUVs) {
                    const at = indices.getX(i) + uvStart + this.uvOffset;
                    const bt = indices.getX(i + 1) + uvStart + this.uvOffset;
                    const ct = indices.getX(i + 2) + uvStart + this.uvOffset;
                    face += `${a}/${at} ${b}/${bt} ${c}/${ct}`;
                } else {
                    face += `${a} ${b} ${c}`;
                }

                faces.push(face);
            }
        } else {
            // Non-indexed geometry
            for (let i = 0; i < positions.count; i += 3) {
                const a = i + vertexStart + this.vertexOffset;
                const b = i + 1 + vertexStart + this.vertexOffset;
                const c = i + 2 + vertexStart + this.vertexOffset;

                let face = 'f ';

                if (hasUVs && hasNormals) {
                    const an = i + normalStart + this.normalOffset;
                    const bn = i + 1 + normalStart + this.normalOffset;
                    const cn = i + 2 + normalStart + this.normalOffset;
                    const at = i + uvStart + this.uvOffset;
                    const bt = i + 1 + uvStart + this.uvOffset;
                    const ct = i + 2 + uvStart + this.uvOffset;
                    face += `${a}/${at}/${an} ${b}/${bt}/${bn} ${c}/${ct}/${cn}`;
                } else if (hasNormals) {
                    const an = i + normalStart + this.normalOffset;
                    const bn = i + 1 + normalStart + this.normalOffset;
                    const cn = i + 2 + normalStart + this.normalOffset;
                    face += `${a}//${an} ${b}//${bn} ${c}//${cn}`;
                } else if (hasUVs) {
                    const at = i + uvStart + this.uvOffset;
                    const bt = i + 1 + uvStart + this.uvOffset;
                    const ct = i + 2 + uvStart + this.uvOffset;
                    face += `${a}/${at} ${b}/${bt} ${c}/${ct}`;
                } else {
                    face += `${a} ${b} ${c}`;
                }

                faces.push(face);
            }
        }

        // Clean up
        geo.dispose();
    }

    // Helper function to download the OBJ and MTL files as a zip
    static async download(content, filename = 'robot.obj') {
        // If content is an object with obj and mtl properties
        if (content.obj && content.mtl) {
            // Create a zip file with both OBJ and MTL
            const zip = new window.JSZip();
            const mtlFilename = filename.replace('.obj', '.mtl');
            const zipFilename = filename.replace('.obj', '.zip');

            zip.file(filename, content.obj);
            zip.file(mtlFilename, content.mtl);

            // Generate and download the zip
            const blob = await zip.generateAsync({ type: 'blob' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = zipFilename;
            link.click();
            URL.revokeObjectURL(url);
        } else {
            // Legacy: just download OBJ
            const blob = new Blob([content], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            link.click();
            URL.revokeObjectURL(url);
        }
    }
}
