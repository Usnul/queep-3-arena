#version 120
/*
 * vertexLitTexture_vp.glsl
 * vertex-lit texture fastpath rendering vertex program
 * Copyright (C) 2010  Jens Loehr <jens.loehr@gmx.de>
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 2 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General
 * Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program; if not, write to the Free Software Foundation, Inc.,
 * 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301, USA.
 */

/* uniform variables */
uniform mat4 u_ModelViewProjectionMatrix;

/* shared variables */
varying vec4 v_TexCoord0;

/*
 * main
 * Entry point for vertex-lit vertex program
 */
void main(void) {
	/* vertex position */
	gl_Position	= u_ModelViewProjectionMatrix * gl_Vertex;
	
	/* texture coordinates */
	v_TexCoord0 = gl_MultiTexCoord0;
}
