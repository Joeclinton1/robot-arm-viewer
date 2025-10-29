import * as THREE from 'three';

// OBJ Exporter for URDF robots
// Exports the current state of the robot to OBJ format with all meshes combined
export class OBJExporter {
    constructor() {
        this.output = '';
        this.vertexOffset = 1;
        this.normalOffset = 1;
        this.uvOffset = 1;
    }

    parse(object) {
        this.output = '';
        this.vertexOffset = 1;
        this.normalOffset = 1;
        this.uvOffset = 1;

        // OBJ file header
        this.output += '# OBJ file exported from URDF Viewer\n';
        this.output += `# Date: ${new Date().toISOString()}\n`;
        this.output += '\n';

        // Parse the object
        this.parseObject(object);

        return this.output;
    }

    parseObject(object, objectName = 'URDFRobot') {
        const vertices = [];
        const normals = [];
        const uvs = [];
        const faces = [];

        // Traverse all meshes in the object
        object.traverse(child => {
            if (child.isMesh && child.geometry) {
                this.parseMesh(child, vertices, normals, uvs, faces);
            }
        });

        // Write header for this object
        if (vertices.length > 0) {
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

            // Write all faces
            faces.forEach(face => {
                this.output += face + '\n';
            });

            this.output += '\n';
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

    // Helper function to download the OBJ file
    static download(content, filename = 'robot.obj') {
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
    }
}
