#version 120
/*
 * generic_fp.glsl
 * generic quake 3 shader rendering fragment program
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
uniform int u_TexEnv;
uniform sampler2D u_Texture0;
uniform sampler2D u_Texture1;

/* texturing.glsl */
#define REPLACE		0
#define MODULATE	1
#define DECAL		2
#define BLEND		3
#define ADD			4
#define COMBINE		5

vec4 applyTexture2D(sampler2D textureUnit, int type, int index, vec4 color);

/*
 * main
 * Entry point for generic fragment program
 */
void main (void) {
	vec4 color = gl_Color;
	
	/* fragment color */
	color = applyTexture2D(u_Texture0, MODULATE, 0, color);
	
	/* multi-texturing */
	if (u_TexEnv > -1) {
		color = applyTexture2D(u_Texture1, u_TexEnv, 1, color);
	}
	
	/* finish */	
	gl_FragColor = color;
}
